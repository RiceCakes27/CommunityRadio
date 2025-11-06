require('dotenv').config({ quiet: true });
const express = require('express');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const { SMTCMonitor } = require('@coooookies/windows-smtc-monitor');
const http = require('http');
const fs = require('fs');
//const https = require('https');
const path = require('path');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT || 3000;
const IP = process.env.IP || 'localhost';

const app = express();
const server = http.createServer(app);
const monitor = new SMTCMonitor();
const io = new Server(server, {
  path: '/ws'
});

const clients = new Set();

const ffmpeg = spawn(ffmpegPath, [
	'-f', 'dshow',
	'-audio_buffer_size', '50',
	'-i', 'audio=Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)', // Input stream from VLC
	'-f', 'mp3',                                                  // Output format
	'-ab', '128k',                                                // Audio bitrate
	'-vn',                                                        // No video
	'pipe:1'                                                      // Pipe the output to stdout
]);

async function broadcastQueue(emitter = io.emit.bind(io)) {
	try {
    // Fetch current song and queue in parallel
    const [songRes, queueRes] = await Promise.all([
      axios.get("http://localhost:26538/api/v1/song"),
      axios.get("http://localhost:26538/api/v1/queue")
    ]);

    // Normalize responses
    const currentRaw = songRes?.data ?? null;
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
      artist: s?.artist ?? "Unknown Artist",
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
    emitter("message", JSON.stringify({
      type: "update",
      current,
      queue
    }));

  } catch (err) {
    // Log error and still emit a safe update so clients won't hang
    console.error("broadcastQueue error:", err?.message ?? err);

    emitter("message", JSON.stringify({
      type: "update",
      current: null,
      queue: []
    }));
  }
}

ffmpeg.stdout.on('data', (chunk) => {
  for (const client of clients) {
    client.write(chunk);
  }
});

ffmpeg.on('error', (err) => {
	console.error('Error starting ffmpeg:', err);
	res.status(500).send('Error starting audio stream.');
});

monitor.on('session-media-changed', (appId) => {
  if (appId == 'com.github.th-ch.youtube-music') {
    broadcastQueue();
  }
});

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
      setTimeout(broadcastQueue, 200);
      res.json({ ok: true });
    }).catch((err) => {
      console.error(err);
    });
});

// Endpoint to stream audio directly
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Connection', 'keep-alive');
	res.removeHeader('Accept-Ranges');

  clients.add(res);
	
  // When the connection ends (due to client closing the stream)
  res.on('close', () => {
    clients.delete(res);
  });
});

io.on('connection', (socket) => {
  broadcastQueue(socket.emit.bind(socket));
});

server.listen(PORT, IP, () => console.log('Server listening on port: '+PORT));