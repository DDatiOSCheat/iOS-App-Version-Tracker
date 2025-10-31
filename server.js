// server.js
import express from 'express';
import axios from 'axios';
import { load } from "cheerio";
import { kv } from '@vercel/kv';
import path from 'path';
import { fileURLToPath } from 'url';
//import fs from 'fs-extra';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
//const DATA_DIR = path.join(__dirname, 'data');
//await fs.ensureDir(DATA_DIR);

// Default app info (Dynamons World)
const DEFAULT_APP_ID = process.env.APP_ID || '1190307500';
const DEFAULT_COUNTRY = 'vn'; // default shown on UI

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static("public"));
app.use(express.json());

/**
 * Fetch latest basic metadata from iTunes lookup (latest version + releaseNotes)
 * This API returns the latest version only.
 */
async function fetchLookup(appId, country = 'us') {
  const url = `https://itunes.apple.com/lookup?id=${appId}&country=${country}`;
  const res = await axios.get(url, { timeout: 15000 });
  return res.data?.results?.[0] || null;
}

/**
 * Scrape App Store page for full version history.
 * We fetch: https://apps.apple.com/{country}/app/id{appId}
 * and parse .version-history__item entries (new App Store UI).
 */
async function fetchFullHistory(appId, country = 'us', lang = 'en') {
  const url = `https://apps.apple.com/${country}/app/id${appId}?l=${lang}`;
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
      'Accept-Language': `${lang},en-US;q=0.9,en;q=0.8`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    },
    timeout: 20000
  });

  const html = res.data;
  const $ = load(html);
  const versions = [];

  // *** LOGIC MỚI ĐỂ XỬ LÝ CẤU TRÚC "whats-new__latest" ***
  // Logic này sẽ chạy trước để ưu tiên cấu trúc mới bạn tìm thấy
  const whatsNewSection = $('section.whats-new');
  if (whatsNewSection.length > 0) {
    const versionTextRaw = whatsNewSection.find('.whats-new__latest__version').text().trim();
    // Dùng regex để lấy số phiên bản, loại bỏ các chữ như "Phiên bản" hoặc "Version"
    const versionMatch = versionTextRaw.match(/([0-9]+\.[0-9]+(\.[0-9]+)*)/);
    const version = versionMatch ? versionMatch[0] : versionTextRaw;

    const date = whatsNewSection.find('time[datetime]').attr('datetime') || whatsNewSection.find('time').text().trim();
    
    // Lấy nội dung notes, thay thế thẻ <br> bằng ký tự xuống dòng
    const notesHTML = whatsNewSection.find('.we-truncate[dir] p').html();
    const notes = notesHTML ? notesHTML.replace(/<br\s*\/?>/gi, '\n').trim() : whatsNewSection.find('.we-truncate[dir] p').text().trim();

    if (version || notes) {
      versions.push({ version: version || null, date: date || null, notes: notes || null });
      console.log('[scrape] Found version using new "whats-new__latest" structure.');
    }
  }

  // Fallback 1: Thử cấu trúc cũ với "version-history__item" (vẫn có thể hữu dụng cho các app khác)
  if (versions.length === 0) {
    $('.version-history__item').each((_, el) => {
      console.log('[scrape] Trying "version-history__item" structure...');
      const item = $(el);
      const version = item.find('.version-history__item__version-number').text().trim() || item.find('h4').text().trim();
      const date = item.find('time').attr('datetime') || item.find('time').text().trim();
      const notes = item.find('.version-history__item__release-notes').text().trim() || item.find('.whats-new__content').text().trim();
      if (version || notes) {
        versions.push({ version: version || null, date: date || null, notes: notes || null });
      }
    });
  }

  // Fallback 2: Cấu trúc cũ hơn nữa
  if (versions.length === 0) {
    $('.whats-new__item, .release-note, .version').each((_, el) => {
      console.log('[scrape] Trying "whats-new__item" fallback...');
      const item = $(el);
      const version = item.find('.whats-new__title, h4, .version-number').text().trim();
      const date = item.find('time').attr('datetime') || item.find('time').text().trim();
      const notes = item.find('.whats-new__content, .release-notes, p').text().trim();
      if (version || notes) versions.push({ version: version || null, date: date || null, notes: notes || null });
    });
  }

  // Phương án cuối cùng: Lấy từ meta description (nguyên nhân gây ra lỗi của bạn)
  if (versions.length === 0) {
    console.log('[scrape] All scrapers failed, falling back to meta description.');
    const metaNotes = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    if (metaNotes) versions.push({ version: null, date: null, notes: metaNotes.trim() });
  }

  return { url, versions };
}


/**
 * Persist version history to Vercel KV, merging new versions with old ones.
 */
async function saveHistory(appId, country, newData) {
  const key = `history_${appId}_${country}`;
  let existingData = await loadHistory(appId, country);

  if (!existingData) {
    existingData = { fullData: { scraped: { versions: [] } } };
  }

  const latestScrapedVersion = newData.scraped?.versions?.[0];

  if (latestScrapedVersion && latestScrapedVersion.version) {
    const isAlreadySaved = existingData.fullData.scraped.versions.some(
      v => v.version === latestScrapedVersion.version
    );

    if (!isAlreadySaved) {
      console.log(`[kv] New version ${latestScrapedVersion.version}. Prepending to history in key: ${key}`);
      existingData.fullData.scraped.versions.unshift(latestScrapedVersion);
    }
  }

  existingData.updatedAt = new Date().toISOString();
  existingData.appId = appId;
  existingData.country = country;
  existingData.fullData.lookup = newData.lookup;

  // Lưu toàn bộ object vào Vercel KV
  await kv.set(key, existingData);
  console.log(`[kv] Successfully saved data to key: ${key}`);
}

/**
 * Load saved history file.
 */
async function loadHistory(appId, country) {
  const key = `history_${appId}_${country}`;
  console.log(`[kv] Loading history from key: ${key}`);
  const data = await kv.get(key);
  return data;
}

/**
 * Send a Discord webhook message.
 * Expects DISCORD_WEBHOOK in .env or env
 */
async function sendDiscordNotification(content, embeds = []) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) {
    console.log('[discord] Skipped — no DISCORD_WEBHOOK configured.');
    return;
  }
  try {
    await axios.post(url, { content, embeds }, { timeout: 10000 });
    console.log('[discord] notification sent');
  } catch (e) {
    console.error('[discord] send failed', e?.message || e);
  }
}

/**
 * Main update-check workflow:
 * - fetch lookup (latest)
 * - fetch full history (scrape)
 * - compare with saved history
 * - if new version detected -> save and notify discord
 */
async function checkAndSave(appId = DEFAULT_APP_ID, country = 'vn', lang = 'vi') {
  try {
    console.log(`[check] start ${appId} @ ${country}`);
    const lookup = await fetchLookup(appId, country).catch(() => null);
    const scraped = await fetchFullHistory(appId, country, lang);

    const fullData = { lookup, scraped };
    const prev = await saveHistory(appId, country, fullData);

    // determine latest version string from lookup or first scraped
    const latestVersion = lookup?.version || (scraped.versions?.[0]?.version || null);
    const prevLatest = prev?.fullData?.lookup?.version || (prev?.fullData?.scraped?.versions?.[0]?.version || null);

    if (latestVersion && latestVersion !== prevLatest) {
      // New version detected
      const title = `Update detected: ${lookup?.trackName || appId} — v${latestVersion}`;
      const notes = lookup?.releaseNotes || (scraped.versions?.[0]?.notes || 'No notes');
      const url = `https://apps.apple.com/${country}/app/id${appId}`;
      const content = `**${title}**\n${notes.substring(0, 800)}\n\n${url}`;
      await sendDiscordNotification(content, [{
        title,
        url,
        description: notes.substring(0, 2000),
        timestamp: new Date().toISOString()
      }]);
      console.log(`[check] new version ${latestVersion} (prev ${prevLatest}) — notified`);
      return { changed: true, latestVersion, prevLatest };
    } else {
      console.log(`[check] no change (latest ${latestVersion} prev ${prevLatest})`);
      return { changed: false, latestVersion, prevLatest };
    }
  } catch (e) {
    console.error('[check] error', e?.message || e);
    return { error: e?.message || String(e) };
  }
}

/* ----------------- Routes ----------------- */

// Main UI
app.get('/', async (req, res) => {
  const appId = req.query.appId || DEFAULT_APP_ID;
  const country = req.query.country || DEFAULT_COUNTRY;
  // Load saved history if exists
  const saved = await loadHistory(appId, country);
  // Basic metadata from lookup
  const lookup = await fetchLookup(appId, country).catch(() => null);
  res.render('index', {
    appId,
    country,
    saved,
    lookup
  });
});

// API: get JSON changelog (reads saved or fetches live if not present)
app.get('/api/changelog', async (req, res) => {
  const appId = req.query.appId || DEFAULT_APP_ID;
  const country = req.query.country || DEFAULT_COUNTRY;
  // try to return saved data first
  const saved = await loadHistory(appId, country);
  if (saved) return res.json({ ok: true, from: 'saved', data: saved });
  // else fetch fresh and save
  const data = await (async () => {
    const lookup = await fetchLookup(appId, country).catch(() => null);
    const scraped = await fetchFullHistory(appId, country, 'en').catch(() => null);
    const fullData = { lookup, scraped, fetchedAt: new Date().toISOString() };
    await saveHistory(appId, country, fullData);
    return fullData;
  })();
  return res.json({ ok: true, from: 'live', data });
});

// API: force refresh (fetch + save)
app.post('/api/refresh', async (req, res) => {
  const { appId = DEFAULT_APP_ID, country = DEFAULT_COUNTRY, lang = 'en' } = req.body;
  const result = await checkAndSave(appId, country, lang);
  res.json({ ok: true, result });
});

/* ------------- Cron Job ------------- */
/*
 - Cron schedule is controlled by env CRON_SCHEDULE (default every 10 minutes)
 - On new version, send Discord webhook
*/
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/10 * * * *'; // every 10 minutes
if (process.env.ENABLE_CRON !== 'false') {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const targetApp = process.env.APP_ID || DEFAULT_APP_ID;
      const targetCountries = (process.env.COUNTRIES || 'vn,us').split(',').map(s => s.trim()).filter(Boolean);
      for (const c of targetCountries) {
        await checkAndSave(targetApp, c, c === 'vn' ? 'vi' : 'en');
      }
    } catch (e) {
      console.error('[cron] error', e?.message || e);
    }
  }, { timezone: process.env.TIMEZONE || 'Asia/Bangkok' });
  console.log(`[cron] scheduled: ${CRON_SCHEDULE} (countries: ${process.env.COUNTRIES || 'vn,us'})`);
} else {
  console.log('[cron] disabled via ENABLE_CRON=false');
}

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
