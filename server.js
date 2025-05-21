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

app.post('/api/shifts/:uid', async (req, res) => {
  const { uid } = req.params;
  const { realStartDate, realStartTime, realEndDate, realEndTime } = req.body;

  // Získání směny z DB
  const shift = await db.get('SELECT * FROM shifts WHERE uid = ?', [uid]);
  const position = shift?.description || '';
  const rate = hourlyRates[position] ?? 0;  // pokud nenajde, dáme 0

  let start, end;
  const useReal = realStartDate && realStartTime && realEndDate && realEndTime;

  if (useReal) {
    start = new Date(`${realStartDate}T${realStartTime}:00Z`);
    end = new Date(`${realEndDate}T${realEndTime}:00Z`);
  } else {
    start = new Date(shift.start);
    end = new Date(shift.end);
  }

  const hours = (end - start) / 3600000;
  const pay = hours * rate;

  if (useReal) {
    // uloží reálné časy + mzdu
    await db.run(
      `UPDATE shifts SET real_startdate = ?, real_starttime = ?, real_enddate = ?, real_endtime = ?, hours = ?, pay = ? WHERE uid = ?`,
      [realStartDate, realStartTime, realEndDate, realEndTime, hours, pay, uid]
    );
  } else {
    // smaže reálné časy, protože nejsou zadány, a přepočítá mzdu z plánovaných časů
    await db.run(
      `UPDATE shifts SET real_startdate = NULL, real_starttime = NULL, real_enddate = NULL, real_endtime = NULL, hours = ?, pay = ? WHERE uid = ?`,
      [hours, pay, uid]
    );
  }

  res.json({ status: 'updated', uid, hours, pay, position, rate, used: useReal ? 'real' : 'planned' });
});

app.get('/api/shifts', async (req, res) => {
  const rows = await db.all('SELECT * FROM shifts ORDER BY start ASC');
  const mapped = rows.map(({ description, start, end, real_startdate, real_starttime, real_enddate, real_endtime, ...rest }) => {
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
    };
  });
  res.json(mapped);
});

const hourlyRates = {
  'Uvaděč': 155.86,
  'Bar': 187,
  'VIP': 193,
};

app.post('/api/shifts/:uid', async (req, res) => {
  const { uid } = req.params;
  const { realStartDate, realStartTime, realEndDate, realEndTime } = req.body;

  // Získání směny z DB
  const shift = await db.get('SELECT * FROM shifts WHERE uid = ?', [uid]);
  const position = shift?.description || '';
  const rate = hourlyRates[position] ?? hourlyRates[''];

  // Pokud jsou zadány reálné časy, použij je, jinak použij plánované časy
  let start, end;
  let useReal = realStartDate && realStartTime && realEndDate && realEndTime;

  if (useReal) {
    start = new Date(`${realStartDate}T${realStartTime}:00Z`);
    end = new Date(`${realEndDate}T${realEndTime}:00Z`);
  } else {
    start = new Date(shift.start);
    end = new Date(shift.end);
  }

  const hours = (end - start) / 3600000;
  const pay = hours * rate;

  // Aktualizace pouze pokud jsou zadány reálné časy, jinak jen přepočet výplaty
  if (useReal) {
    await db.run(
      `UPDATE shifts SET real_startdate = ?, real_starttime = ?, real_enddate = ?, real_endtime = ?, hours = ?, pay = ? WHERE uid = ?`,
      [realStartDate, realStartTime, realEndDate, realEndTime, hours, pay, uid]
    );
  } else {
    await db.run(
      `UPDATE shifts SET hours = ?, pay = ? WHERE uid = ?`,
      [hours, pay, uid]
    );
  }

  res.json({ status: 'updated', uid, hours, pay, position, rate, used: useReal ? 'real' : 'planned' });
});

initDb().then(() => {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
  });
});