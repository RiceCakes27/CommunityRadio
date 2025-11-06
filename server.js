const express = require('express');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const http = require('http');
const youtubedl = require('yt-dlp-exec');
const fs = require('fs');
const https = require('https');
const path = require('path');
const ffprobe = require('ffprobe-static');
require('dotenv').config({ quiet: true });

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY; // Set this in your environment
const PORT = process.env.PORT || 3000;
const IP = processs.env.IP || 'localhost';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/ws'
});

let queue = [];
let current = null;
let startTime = null;
let currentTimeout = null;

function broadcastQueue() {
  const elapsed = current && startTime ? Date.now() - startTime : 0;
  io.emit('message', JSON.stringify({
    type: 'update',
    current: current ? { ...current, filename: path.basename(current.filepath), elapsed } : null,
    queue: queue.map(song => ({ ...song, filename: path.basename(song.filepath) }))
  }));
}

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

async function getDurationMs(filepath) {
  return new Promise((resolve) => {
    const ff = spawn(ffprobe.path, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filepath
    ]);

    let output = '';
    ff.stdout.on('data', d => output += d);
    ff.on('close', () => {
      const dur = parseFloat(output);
      if (!isNaN(dur)) resolve(dur * 1000);
      else {
        console.warn(`Could not get duration for: ${filepath}, defaulting to 3 minutes`);
        resolve(3 * 60 * 1000);
      }
    });

    ff.on('error', (err) => {
      console.error(`ffprobe failed for ${filepath}:`, err);
      resolve(3 * 60 * 1000);
    });
  });
}

async function downloadSong(videoId) {
  const metadata = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
    dumpSingleJson: true,
    noWarnings: true,
    addHeader: [
      'referer:youtube.com',
      'user-agent:Mozilla/5.0'
    ]
  });

  const title = metadata.title || `video_${videoId}`;
  const filename = sanitizeFilename(title) + '.mp3';
  const filepath = path.join(__dirname, 'songs', filename);

  if (!fs.existsSync(filepath)) {
    await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
      output: filepath,
      extractAudio: true,
      audioFormat: 'mp3'
    });
  }

  const durationMs = await getDurationMs(filepath);

  return { title, filename, filepath, videoId, durationMs };
}

async function playNext() {
  if (currentTimeout) {
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }

  if (queue.length === 0) {
    current = null;
    startTime = null;
    broadcastQueue();
    return;
  }

  const next = queue.shift();
  current = next;
  startTime = Date.now();
  broadcastQueue();

  currentTimeout = setTimeout(() => {
    playNext();
  }, next.durationMs);
}

async function fallbackYtDlpSearch(query, res) {
  try {
    const result = await youtubedl(`ytsearch5:${query} music`, {
      dumpSingleJson: true,
      noWarnings: true,
      preferFreeFormats: true,
      noCheckCertificates: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0'
      ]
    });

    const results = result.entries.map(entry => ({
      title: entry.title,
      videoId: entry.id
    }));

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Search failed', details: err.toString() });
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ results: [] });

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=5&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
  https.get(url, (apiRes) => {
    let raw = '';
    apiRes.on('data', chunk => raw += chunk);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) throw new Error(parsed.error.message);

        const results = parsed.items.map(item => ({
          title: item.snippet.title,
          videoId: item.id.videoId
        }));
        res.json({ results });
      } catch (err) {
        console.warn('YouTube API failed, falling back to yt-dlp search...');
        fallbackYtDlpSearch(query, res);
      }
    });
  }).on('error', err => {
    console.warn('YouTube API error:', err);
    fallbackYtDlpSearch(query, res);
  });
});

app.post('/api/queue', async (req, res) => {
  const { videoId } = req.body;
  const downloaded = await downloadSong(videoId);
  queue.push(downloaded);
  broadcastQueue();
  if (!current) playNext();
  else {
    const nextFive = queue.slice(0, 5);
    for (const song of nextFive) {
      await downloadSong(song.videoId);
    }
  }
  res.json({ ok: true });
});

// Stream endpoint for playing songs
app.get('/stream/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(__dirname, 'songs', filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    const file = fs.createReadStream(filepath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/mpeg'
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg'
    };
    res.writeHead(200, head);
    fs.createReadStream(filepath).pipe(res);
  }
});

io.on('connection', (socket) => {
  broadcastQueue();
});

server.listen(PORT, IP, () => console.log('Server listening on port: '+PORT));

['songs', 'public'].forEach(folder => {
  const dir = path.join(__dirname, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});