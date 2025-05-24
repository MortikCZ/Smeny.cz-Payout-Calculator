import express from 'express';
import fetch from 'node-fetch';
import ical from 'node-ical';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cors from 'cors';

const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

let db;

const initDb = async () => {
  db = await open({
    filename: './shifts.db',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS shifts (
      uid TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      start TEXT,
      end TEXT,
      real_startdate TEXT,
      real_starttime TEXT,
      real_enddate TEXT,
      real_endtime TEXT,
      hours REAL,
      pay REAL
    );
  `);

  const columns = await db.all(`PRAGMA table_info(shifts);`);
  const hasBonuses = columns.some(col => col.name === 'bonuses');
  if (!hasBonuses) {
    await db.exec(`ALTER TABLE shifts ADD COLUMN bonuses TEXT;`);
    console.log('Sloupec bonuses byl do tabulky shifts přidán.');
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS bonuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      date TEXT,
      weekday INTEGER,
      time_from TEXT,
      time_to TEXT,
      percent REAL
    );
  `);
};

async function getIcaldata(iCalUrl) {
  const response = await fetch(iCalUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
    },
  });
  return await response.text();
}

const hourlyRates = {
  'Uvaděč': 155.86,
  'Bar': 187,
  'VIP': 193,
};

function parseTimeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function getOverlapMinutes(interval1Start, interval1End, interval2Start, interval2End) {
    return Math.max(0, Math.min(interval1End, interval2End) - Math.max(interval1Start, interval2Start));
}

app.post('/api/shifts/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const { realStartDate, realStartTime, realEndDate, realEndTime, bonuses = [] } = req.body;

    const shift = await db.get('SELECT * FROM shifts WHERE uid = ?', [uid]);

    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const position = shift.description || '';
    const rate = hourlyRates[position] ?? 0;

    let startDateTime, endDateTime;
    const useReal = realStartDate && realStartTime && realEndDate && realEndTime;

    if (useReal) {
      startDateTime = new Date(`${realStartDate}T${realStartTime}:00Z`);
      endDateTime = new Date(`${realEndDate}T${realEndTime}:00Z`);
    } else {
      startDateTime = new Date(shift.start);
      endDateTime = new Date(shift.end);
    }

    const hours = (endDateTime - startDateTime) / 3600000;
    let pay = hours * rate;

    const shiftStartMinutes = parseTimeToMinutes(startDateTime.toISOString().slice(11, 16));
    let shiftEndMinutes = parseTimeToMinutes(endDateTime.toISOString().slice(11, 16));

    if (endDateTime > startDateTime && endDateTime.getUTCDate() !== startDateTime.getUTCDate()) {
        shiftEndMinutes += 24 * 60;
    } else if (endDateTime <= startDateTime) {
        shiftEndMinutes += 24 * 60;
    }

    for (const bonus of bonuses) {
      if (!bonus.from || !bonus.to || !bonus.percent || isNaN(bonus.percent)) continue;

      let bonusFromMinutes = parseTimeToMinutes(bonus.from);
      let bonusToMinutes = parseTimeToMinutes(bonus.to);

      if (bonusToMinutes <= bonusFromMinutes) {
          bonusToMinutes += 24 * 60;
      }

      let totalBonusMinutes = 0;

      if (bonusToMinutes <= shiftStartMinutes && shiftEndMinutes > 24 * 60) {
           totalBonusMinutes += getOverlapMinutes(shiftStartMinutes, shiftEndMinutes, bonusFromMinutes + 24 * 60, bonusToMinutes + 24 * 60);
      } else {
           totalBonusMinutes += getOverlapMinutes(shiftStartMinutes, shiftEndMinutes, bonusFromMinutes, bonusToMinutes);
      }

      const bonusHours = totalBonusMinutes / 60;
      const bonusPay = bonusHours * rate * (bonus.percent / 100);
      pay += bonusPay;

      // Debugging výpis
      console.log(
        `Příplatek ${bonus.from}-${bonus.to} (${bonus.percent} %): ` +
        `bonusHours=${bonusHours.toFixed(2)}, bonusPay=${bonusPay.toFixed(2)} Kč`
      );
    }

    if (useReal) {
      await db.run(
        `UPDATE shifts SET real_startdate = ?, real_starttime = ?, real_enddate = ?, real_endtime = ?, hours = ?, pay = ?, bonuses = ? WHERE uid = ?`,
        [realStartDate, realStartTime, realEndDate, realEndTime, hours, pay, JSON.stringify(bonuses), uid]
      );
    } else {
      await db.run(
        `UPDATE shifts SET real_startdate = NULL, real_starttime = NULL, real_enddate = NULL, real_endtime = NULL, hours = ?, pay = ?, bonuses = ? WHERE uid = ?`,
        [hours, pay, JSON.stringify(bonuses), uid]
      );
    }

    res.json({
      status: 'updated',
      uid,
      hours,
      pay,
      position,
      rate,
      used: useReal ? 'real' : 'planned',
    });
  } catch (error) {
    console.error('Error updating shift:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/load-ical', async (req, res) => {
  try {
    const { iCalUrl } = req.body;

    if (!iCalUrl) {
      return res.status(400).json({ error: 'Missing iCalUrl' });
    }

    const icalRawData = await getIcaldata(iCalUrl);
    const parsed = ical.parseICS(icalRawData);

    let count = 0;

    for (const key in parsed) {
      const event = parsed[key];
      if (event.type === 'VEVENT') {
        const {
          uid,
          summary: title,
          description,
          start,
          end,
        } = event;

        const startLocal = new Date(start.getTime() + 2 * 60 * 60 * 1000);
        const endLocal = new Date(end.getTime() + 2 * 60 * 60 * 1000);

        const hours = (endLocal - startLocal) / 3600000;
        const rate = hourlyRates[description] ?? 0;
        const pay = hours * rate;

        const exists = await db.get('SELECT uid FROM shifts WHERE uid = ?', [uid]);
        if (!exists) {
          await db.run(
            `INSERT INTO shifts (uid, title, description, start, end, hours, pay, bonuses)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [uid, title, description, startLocal.toISOString(), endLocal.toISOString(), hours, pay, '[]']
          );
          count++;
        }
      }
    }

    res.json({ status: 'success', imported: count });
  } catch (error) {
    console.error('Error loading iCal:', error);
    res.status(500).json({ error: 'Failed to load iCal' });
  }
});

app.get('/api/shifts', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM shifts ORDER BY start ASC');

    const mapped = rows.map(
      ({ description, start, end, real_startdate, real_starttime, real_enddate, real_endtime, bonuses, ...rest }) => {
        const startDateObj = new Date(start);
        const endDateObj = new Date(end);
        return {
          ...rest,
          position: description,
          start_date: startDateObj.toISOString().slice(0, 10),
          start_time: startDateObj.toISOString().slice(11, 16),
          end_date: endDateObj.toISOString().slice(0, 10),
          end_time: endDateObj.toISOString().slice(11, 16),
          real_startdate,
          real_starttime,
          real_enddate,
          real_endtime,
          bonuses: bonuses ? JSON.parse(bonuses) : []
        };
      }
    );

    res.json(mapped);
  } catch (error) {
    console.error('Error fetching shifts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bonuses', async (req, res) => {
  const { type, date, weekday, time_from, time_to, percent } = req.body;
  try {
    await db.run(
      `INSERT INTO bonuses (type, date, weekday, time_from, time_to, percent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [type, date, weekday, time_from, time_to, percent]
    );
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add bonus' });
  }
});

app.get('/api/payout', async (req, res) => {
  try {
    const { month } = req.query; // ve formátu "2025-05"
    if (!month) return res.status(400).json({ error: 'Chybí měsíc' });

    // Získání všech směn v daném měsíci
    const rows = await db.all(
      `SELECT pay, start FROM shifts WHERE substr(start, 1, 7) = ?`,
      [month]
    );
    const gross = rows.reduce((sum, row) => sum + (row.pay || 0), 0);

    const tax = gross * 0.15;
    const insurance = gross * 0.115;
    const taxDiscount = 2700;
    const net = gross - tax - insurance + taxDiscount;

    res.json({ gross, tax, insurance, taxDiscount, net });
  } catch (error) {
    res.status(500).json({ error: 'Chyba při výpočtu výplaty' });
  }
});

initDb().then(() => {
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
});