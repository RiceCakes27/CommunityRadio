const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const nowPlaying = document.getElementById('nowPlaying');
const queueList = document.getElementById('queueList');
const player = document.getElementById('player');

const socket = io({ path: location.pathname+'ws' });
player.src = location+`stream?nocache=${Date.now()}`;
player.play();

socket.on('message', (raw) => {
    let data;
    try {
        data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return;
    }
    if (data.type === 'update') {
        if (data.current) {
            nowPlaying.textContent = `Now Playing: ${data.current.title} - ${data.current.artist}`;
        } else {
            nowPlaying.textContent = 'Nothing playing yet.';
        }

        queueList.innerHTML = '';
        if (Array.isArray(data.queue)) {
            data.queue.forEach(song => {
                const li = document.createElement('li');
                li.textContent = song.title;
                queueList.appendChild(li);
                //document.getElementById('overlay').style.display = 'none';
            });
        }
    }
});

let searchTimeout = null;

searchInput.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (!query) {
        searchResults.innerHTML = '';
        return;
    }
    searchTimeout = setTimeout(() => {
        fetch(`api/search?q=${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
            searchResults.innerHTML = '';
            if (data.results && data.results.length > 0) {
                data.results.forEach(song => {
                    const li = document.createElement('li');
                    li.textContent = song.title;
                    li.title = song.title;
                    li.style.userSelect = 'none';
                    li.addEventListener('click', () => {
                        //document.getElementById('overlay').style.display = 'flex';

                        fetch('api/queue', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ videoId: song.videoId })
                        }).then(res => {
                            if (res.ok) {
                                searchInput.value = '';
                                searchResults.innerHTML = '';
                            } else {
                                alert('Failed to add song to queue');
                            }
                        });
                    });
                    searchResults.appendChild(li);
                });
            } else {
                searchResults.textContent = 'No results found.';
            }
        }).catch(() => {
            searchResults.textContent = 'Search failed.';
        });
    }, 500); // debounce 500ms
});