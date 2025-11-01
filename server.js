const express = require('express');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');
//const https = require('https');
const path = require('path');
const ffprobe = require('ffprobe-static');
require('dotenv').config();
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/ws'
});

let queue = [];
let current = null;
let currentTimeout = null;

async function broadcastQueue() {
  try {
    // Fetch current song and queue in parallel
    const [songRes, queueRes] = await Promise.all([
      axios.get("http://localhost:26538/api/v1/song"),
      axios.get("http://localhost:26538/api/v1/queue")
    ]);

    // Normalize responses
    const currentRaw = songRes?.data ?? null;
    //const queueRaw = Array.isArray(queueRes?.data) ? queueRes.data : (queueRes?.data?.items[0].playlistPanelVideoRenderer.title.runs[0] ?? []);
    const items = queueRes?.data?.items ?? [];
    // Find index of currently selected item
    const selectedIndex = items.findIndex(
      item => item?.playlistPanelVideoRenderer?.selected === true
    );

    // Get only the items AFTER the selected one
    const upcomingItems = selectedIndex >= 0 ? items.slice(selectedIndex + 1) : items;

    // Convert those into parsed song objects
    const queueRaw = upcomingItems
      .map(item => {
        const r = item?.playlistPanelVideoRenderer;
        if (!r) return null;

        return {
          title: r.title?.runs?.[0]?.text ?? "Unknown Title"
        };
      })
      .filter(Boolean);

    // Map a single song to the expected /api/v1/song shape with safe defaults
    const mapSong = (s) => ({
      title: s?.title ?? (s?.filename ? path.basename(s.filename) : ""),
      //artist: s?.artist ?? "Unknown Artist",
      //views: typeof s?.views === "number" ? s.views : 0,
      //uploadDate: s?.uploadDate ?? "",
      //imageSrc: s?.imageSrc ?? "",
      //songDuration: typeof s?.songDuration === "number" ? s.songDuration : 0,
      //elapsedSeconds: typeof s?.elapsedSeconds === "number" ? s.elapsedSeconds : 0,
      //url: s?.url ?? "",
      //album: s?.album ?? "",
      //videoId: s?.videoId ?? "",
    });

    const current = currentRaw ? mapSong(currentRaw) : null;
    const queue = queueRaw.map(song => {
      const mapped = mapSong(song);
      // user example wanted filename: song.title — add it explicitly
      return { ...mapped, filename: mapped.text };
    });

    // Emit once, after data is ready
    io.emit("message", JSON.stringify({
      type: "update",
      current,
      queue
    }));

  } catch (err) {
    // Log error and still emit a safe update so clients won't hang
    console.error("broadcastQueue error:", err?.message ?? err);

    io.emit("message", JSON.stringify({
      type: "update",
      current: null,
      queue: []
    }));
  }
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ results: [] });
  const data = {
    query: query,
  };
  axios.post('http://localhost:26538/api/v1/search', data)
    .then((response) => {
        //console.log(`Status: ${res.status}`);
        let videos = response.data.contents.tabbedSearchResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[1].musicShelfRenderer.contents;
        let parsed = {
          videos: []
        };
        for (let i = 0; videos.length > i; i++) {
          let video = videos[i].musicResponsiveListItemRenderer.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0];
          try {
            if (video.navigationEndpoint.watchEndpoint.videoId) {
              //console.log('Title: ', video.text);
              //console.log('ID: ', video.navigationEndpoint.watchEndpoint.videoId);
              parsed.videos.push({
                title: video.text,
                videoId: video.navigationEndpoint.watchEndpoint.videoId
              });
            }
          } catch (error) {
            
          }
        }
        const results = parsed.videos.map(video => ({
            title: video.title,
            videoId: video.videoId
        }));
        //console.log(results)
        res.json({ results });
    }).catch((err) => {
        console.error(err);
    });
});

app.post('/api/queue', async (req, res) => {
  const { videoId } = req.body;
  const data = {
    videoId: videoId,
    insertPosition: "INSERT_AT_END"
  };
  axios.post('http://localhost:26538/api/v1/queue', data)
    .then((response) => {
      broadcastQueue();
    }).catch((err) => {
      console.error(err);
    });
  res.json({ ok: true });
    //if (!current) playNext();
  /*const downloaded = await downloadSong(videoId);
  queue.push(downloaded);
  broadcastQueue();
  if (!current) playNext();
  else {
    const nextFive = queue.slice(0, 5);
    for (const song of nextFive) {
      await downloadSong(song.videoId);
    }
  }
  res.json({ ok: true });*/
});

// Endpoint to stream audio directly
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Connection', 'keep-alive'); // Keep the connection open

  console.log('Starting stream...');

  const ffmpeg = spawn(ffmpegPath, [
    '-f', 'dshow',
    '-i', 'audio=Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)',      // Input stream from VLC
    '-f', 'mp3',             // Output format
    '-ab', '128k',           // Audio bitrate
    '-vn',                   // No video
    'pipe:1'                 // Pipe the output to stdout
  ]);

  ffmpeg.on('error', (err) => {
    console.error('Error starting ffmpeg:', err);
    res.status(500).send('Error starting audio stream.');
  });

  // Update last activity time whenever data is sent
  ffmpeg.stdout.on('data', () => {
    //connectedIPs.set(req.normalizedIP, Date.now()); // Update activity time
  });

  ffmpeg.stdout.pipe(res);

  // When the connection ends (due to client closing the stream)
  res.on('close', () => {
    console.log('Client disconnected, stopping stream...');
    ffmpeg.kill('SIGINT'); // Stop ffmpeg when client disconnects

    // Delay removal of the IP to avoid premature deletions
    //connectedIPs.delete(req.normalizedIP);
    //printConnectedIPs();
  });
});

io.on('connection', (socket) => {
  broadcastQueue();
});

server.listen(PORT, () => console.log('Server listening on port '+PORT));

['songs', 'public'].forEach(folder => {
  const dir = path.join(__dirname, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});