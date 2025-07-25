const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    // Mobile optimization settings
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Game state storage
const lobbies = new Map();
const gameStates = new Map();
const disconnectedPlayers = new Map();

// Load topics from file
let neverHaveIEverTopics = [];
try {
    const topicsContent = fs.readFileSync('never_have_i_ever_topics.txt', 'utf8');
    neverHaveIEverTopics = topicsContent.split('\n')
        .map(topic => topic.trim())
        .filter(topic => topic.length > 0);
    console.log(`Loaded ${neverHaveIEverTopics.length} never have i ever topics`);
} catch (error) {
    console.error('Error loading never_have_i_ever_topics.txt:', error);
    neverHaveIEverTopics = [
        "eaten a bug on purpose",
        "gone skinny dipping",
        "lied about my age",
        "pretended to be sick to skip work/school",
        "stalked someone on social media for hours",
        "cried during a movie",
        "had a crush on a teacher",
        "stolen something from a store",
        "been in a fight",
        "kissed someone on the first date",
        "gotten a tattoo I regret",
        "fallen asleep during a movie in theaters",
        "texted the wrong person by mistake",
        "pretended to know a song I didn't know",
        "laughed so hard I peed myself",
        "been caught talking to myself",
        "eaten food off the floor",
        "googled myself",
        "had an imaginary friend as a child",
        "been kicked out of a public place"
    ];
}

// Helper function to generate lobby codes
function generateLobbyCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Helper function to sync game state to a player
function syncGameStateToPlayer(socketId, code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return;
    
    let userVote = null;
    if (gameState.phase === 'initial-voting' || gameState.phase === 'initial-results') {
        userVote = gameState.initialVotes[socket.username];
    } else if (gameState.phase === 'confession') {
        userVote = gameState.confession;
    } else if (gameState.phase === 'guessing' || gameState.phase === 'confession-results') {
        userVote = gameState.guesses[socket.username];
    }
    
    socket.emit('sync-game-state', {
        gameState: {
            phase: gameState.phase,
            roundNumber: gameState.roundNumber,
            currentTopic: gameState.currentTopic,
            timer: gameState.timer,
            scores: gameState.scores,
            selectedPlayer: gameState.selectedPlayer
        },
        lobby: lobby,
        userVote: userVote
    });
}

// API Routes
app.post('/api/lobby/create', (req, res) => {
    const { username } = req.body;
    
    if (!username || username.length < 2) {
        return res.status(400).json({ error: 'Username must be at least 2 characters' });
    }
    
    const code = generateLobbyCode();
    const lobby = {
        code,
        host: username,
        participants: [{ username, isHost: true, connected: true }],
        createdAt: new Date(),
        gameStarted: false
    };
    
    lobbies.set(code, lobby);
    
    res.json({ code, lobby });
});

app.post('/api/lobby/join', (req, res) => {
    const { code, username } = req.body;
    
    if (!code || !username) {
        return res.status(400).json({ error: 'Code and username are required' });
    }
    
    const lobby = lobbies.get(code);
    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found' });
    }
    
    // Check if this is a reconnection
    const existingParticipant = lobby.participants.find(p => p.username === username);
    if (existingParticipant) {
        existingParticipant.connected = true;
        return res.json({ lobby, reconnection: true });
    }
    
    // Add new participant
    lobby.participants.push({ username, isHost: false, connected: true });
    
    // If game is active, initialize score for new player
    const gameState = gameStates.get(code);
    if (gameState) {
        gameState.scores[username] = 0;
    }
    
    res.json({ lobby });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('join-lobby', (data) => {
        const { code, username } = data;
        socket.join(code);
        socket.username = username;
        socket.lobbyCode = code;
        
        const lobby = lobbies.get(code);
        if (lobby) {
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                participant.connected = true;
            }
            
            const gameState = gameStates.get(code);
            if (gameState && gameState.phase !== 'waiting') {
                setTimeout(() => {
                    syncGameStateToPlayer(socket.id, code);
                }, 1000);
            }
            
            io.to(code).emit('lobby-updated', lobby);
        }
    });
    
    socket.on('leave-lobby', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby) {
            if (gameState && gameState.phase !== 'waiting') {
                const participant = lobby.participants.find(p => p.username === username);
                if (participant) {
                    participant.connected = false;
                    disconnectedPlayers.set(username, { code, timestamp: Date.now() });
                }
                io.to(code).emit('lobby-updated', lobby);
            } else {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                
                if (lobby.participants.length === 0 || username === lobby.host) {
                    lobbies.delete(code);
                    gameStates.delete(code);
                    io.to(code).emit('lobby-closed');
                } else {
                    io.to(code).emit('lobby-updated', lobby);
                }
            }
        }
        
        socket.leave(code);
    });
    
    socket.on('start-game', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        
        if (lobby && lobby.host === username && lobby.participants.length >= 2) {
            lobby.gameStarted = true;
            
            const gameState = {
                phase: 'initial-voting',
                roundNumber: 1,
                totalRounds: 15,
                currentTopic: null,
                initialVotes: {},
                selectedPlayer: null,
                playerInitialVote: null,
                confession: null,
                guesses: {},
                scores: {},
                usedTopics: [],
                timer: 30,
                timerInterval: null
            };
            
            // Initialize scores
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            gameStates.set(code, gameState);
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startInitialVotingPhase(code);
            }, 2000);
        }
    });
    
    socket.on('cast-initial-vote', (data) => {
        const { code, username, vote } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'initial-voting') {
            gameState.initialVotes[username] = vote;
            
            const lobby = lobbies.get(code);
            const connectedPlayers = lobby.participants.filter(p => p.connected !== false);
            
            // Check if all connected players have voted
            const allPlayersVoted = connectedPlayers.every(player => 
                gameState.initialVotes.hasOwnProperty(player.username)
            );
            
            if (allPlayersVoted) {
                // Only skip early if at least 15 seconds have passed
                const timeElapsed = 30 - gameState.timer;
                const minimumVotingTime = 15;
                
                if (timeElapsed >= minimumVotingTime) {
                    if (gameState.timerInterval) {
                        clearInterval(gameState.timerInterval);
                        gameState.timerInterval = null;
                    }
                    
                    setTimeout(() => {
                        calculateInitialResults(code);
                    }, 1000);
                }
            }
        }
    });
    
    socket.on('make-confession', (data) => {
        const { code, username, confession } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'confession' && gameState.selectedPlayer === username) {
            gameState.confession = confession;
            
            // Clear the timer and move to guessing phase
            if (gameState.timerInterval) {
                clearInterval(gameState.timerInterval);
                gameState.timerInterval = null;
            }
            
            setTimeout(() => {
                startGuessingPhase(code);
            }, 1000);
        }
    });
    
    socket.on('make-guess', (data) => {
        const { code, username, guess } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'guessing' && username !== gameState.selectedPlayer) {
            gameState.guesses[username] = guess;
            
            const lobby = lobbies.get(code);
            const connectedPlayers = lobby.participants.filter(p => p.connected !== false);
            const playersWhoCanGuess = connectedPlayers.filter(p => p.username !== gameState.selectedPlayer);
            
            // Check if all players who can guess have guessed
            const allPlayersGuessed = playersWhoCanGuess.every(player => 
                gameState.guesses.hasOwnProperty(player.username)
            );
            
            if (allPlayersGuessed) {
                // Only skip early if at least 15 seconds have passed
                const timeElapsed = 30 - gameState.timer;
                const minimumGuessingTime = 15;
                
                if (timeElapsed >= minimumGuessingTime) {
                    if (gameState.timerInterval) {
                        clearInterval(gameState.timerInterval);
                        gameState.timerInterval = null;
                    }
                    
                    setTimeout(() => {
                        calculateConfessionResults(code);
                    }, 1000);
                }
            }
        }
    });
    
    socket.on('request-sync', (data) => {
        const { code } = data;
        syncGameStateToPlayer(socket.id, code);
    });
    
    socket.on('restart-game', (data) => {
        const { code } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby && gameState && socket.username === lobby.host) {
            gameState.phase = 'initial-voting';
            gameState.roundNumber = 1;
            gameState.currentTopic = null;
            gameState.initialVotes = {};
            gameState.selectedPlayer = null;
            gameState.playerInitialVote = null;
            gameState.confession = null;
            gameState.guesses = {};
            gameState.usedTopics = [];
            gameState.timer = 30;
            
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            if (gameState.timerInterval) {
                clearInterval(gameState.timerInterval);
            }
            
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startInitialVotingPhase(code);
            }, 2000);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.lobbyCode && socket.username) {
            const lobby = lobbies.get(socket.lobbyCode);
            const gameState = gameStates.get(socket.lobbyCode);
            
            if (lobby) {
                const participant = lobby.participants.find(p => p.username === socket.username);
                
                if (participant) {
                    if (gameState && gameState.phase !== 'waiting') {
                        participant.connected = false;
                        disconnectedPlayers.set(socket.username, { 
                            code: socket.lobbyCode, 
                            timestamp: Date.now() 
                        });
                        io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                    } else {
                        lobby.participants = lobby.participants.filter(p => p.username !== socket.username);
                        
                        if (lobby.participants.length === 0 || socket.username === lobby.host) {
                            if (gameState && gameState.timerInterval) {
                                clearInterval(gameState.timerInterval);
                            }
                            
                            lobbies.delete(socket.lobbyCode);
                            gameStates.delete(socket.lobbyCode);
                            io.to(socket.lobbyCode).emit('lobby-closed');
                        } else {
                            io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                        }
                    }
                }
            }
        }
    });
});

// Clean up old disconnected players
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    disconnectedPlayers.forEach((data, username) => {
        if (now - data.timestamp > timeout) {
            const lobby = lobbies.get(data.code);
            if (lobby) {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                io.to(data.code).emit('lobby-updated', lobby);
            }
            disconnectedPlayers.delete(username);
        }
    });
}, 60000);

// Game logic functions
function startInitialVotingPhase(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Select a random topic that hasn't been used
    const availableTopics = neverHaveIEverTopics.filter((topic, index) => 
        !gameState.usedTopics.includes(index)
    );
    
    if (availableTopics.length === 0) {
        endGame(code);
        return;
    }
    
    const randomIndex = Math.floor(Math.random() * availableTopics.length);
    const selectedTopic = availableTopics[randomIndex];
    const originalIndex = neverHaveIEverTopics.indexOf(selectedTopic);
    
    gameState.currentTopic = selectedTopic;
    gameState.usedTopics.push(originalIndex);
    gameState.phase = 'initial-voting';
    gameState.initialVotes = {};
    gameState.selectedPlayer = null;
    gameState.playerInitialVote = null;
    gameState.confession = null;
    gameState.guesses = {};
    gameState.timer = 30;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('topic-selected', { topic: selectedTopic });
    io.to(code).emit('game-phase-update', {
        phase: 'initial-voting',
        roundNumber: gameState.roundNumber
    });
    
    startTimer(code, 30, () => {
        calculateInitialResults(code);
    });
}

function calculateInitialResults(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Count votes (only from connected players)
    const voteResults = { yes: 0, no: 0 };
    
    lobby.participants.forEach(participant => {
        if (participant.connected) {
            const vote = gameState.initialVotes[participant.username];
            if (vote === 'yes') {
                voteResults.yes++;
            } else if (vote === 'no') {
                voteResults.no++;
            }
        }
    });
    
    // Determine majority and award points
    let majorityVote = null;
    
    if (voteResults.yes > voteResults.no) {
        majorityVote = 'yes';
    } else if (voteResults.no > voteResults.yes) {
        majorityVote = 'no';
    }
    
    // Award points to majority voters
    if (majorityVote) {
        lobby.participants.forEach(participant => {
            if (gameState.initialVotes[participant.username] === majorityVote) {
                gameState.scores[participant.username] += 1;
            }
        });
    }
    
    gameState.phase = 'initial-results';
    
    io.to(code).emit('game-phase-update', { phase: 'initial-results' });
    io.to(code).emit('initial-vote-results', {
        votes: voteResults,
        majorityVote: majorityVote,
        topic: gameState.currentTopic
    });
    
    setTimeout(() => {
        selectRandomPlayer(code);
    }, 4000);
}

function selectRandomPlayer(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Get all connected players who voted
    const eligiblePlayers = lobby.participants.filter(participant => 
        participant.connected && gameState.initialVotes.hasOwnProperty(participant.username)
    );
    
    if (eligiblePlayers.length === 0) {
        endGame(code);
        return;
    }
    
    // Select random player
    const randomIndex = Math.floor(Math.random() * eligiblePlayers.length);
    const selectedPlayer = eligiblePlayers[randomIndex];
    
    gameState.selectedPlayer = selectedPlayer.username;
    gameState.playerInitialVote = gameState.initialVotes[selectedPlayer.username];
    gameState.phase = 'player-selection';
    
    io.to(code).emit('game-phase-update', { 
        phase: 'player-selection',
        selectedPlayer: selectedPlayer.username
    });
    io.to(code).emit('player-selected', {
        selectedPlayer: selectedPlayer.username,
        playerVote: gameState.playerInitialVote
    });
    
    setTimeout(() => {
        startConfessionPhase(code);
    }, 3000);
}

function startConfessionPhase(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'confession';
    gameState.confession = null;
    gameState.timer = 60;
    
    io.to(code).emit('game-phase-update', { 
        phase: 'confession',
        selectedPlayer: gameState.selectedPlayer
    });
    
    startTimer(code, 60, () => {
        // If no confession made, assume they were honest
        if (gameState.confession === null) {
            gameState.confession = 'true';
        }
        startGuessingPhase(code);
    });
}

function startGuessingPhase(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'guessing';
    gameState.guesses = {};
    gameState.timer = 30;
    
    io.to(code).emit('game-phase-update', { 
        phase: 'guessing',
        selectedPlayer: gameState.selectedPlayer
    });
    
    startTimer(code, 30, () => {
        calculateConfessionResults(code);
    });
}

function calculateConfessionResults(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Count guesses (only from connected players, excluding selected player)
    const guessResults = { honest: 0, lied: 0 };
    
    lobby.participants.forEach(participant => {
        if (participant.connected && participant.username !== gameState.selectedPlayer) {
            const guess = gameState.guesses[participant.username];
            if (guess === 'true') {
                guessResults.honest++;
            } else if (guess === 'false') {
                guessResults.lied++;
            }
        }
    });
    
    // Award points to correct guessers
    const actualConfession = gameState.confession || 'true';
    lobby.participants.forEach(participant => {
        if (participant.connected && participant.username !== gameState.selectedPlayer) {
            const guess = gameState.guesses[participant.username];
            if (guess === actualConfession) {
                gameState.scores[participant.username] += 3;
            }
        }
    });
    
    gameState.phase = 'confession-results';
    
    io.to(code).emit('game-phase-update', { phase: 'confession-results' });
    io.to(code).emit('confession-results', {
        guesses: guessResults,
        actualConfession: actualConfession,
        selectedPlayer: gameState.selectedPlayer
    });
    
    setTimeout(() => {
        showScoreboard(code);
    }, 5000);
}

function showScoreboard(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'scoreboard';
    
    io.to(code).emit('game-phase-update', { phase: 'scoreboard' });
    io.to(code).emit('scoreboard-update', { scores: gameState.scores });
    
    setTimeout(() => {
        gameState.roundNumber++;
        
        if (gameState.roundNumber > gameState.totalRounds || gameState.usedTopics.length >= neverHaveIEverTopics.length) {
            endGame(code);
        } else {
            gameState.phase = 'waiting';
            io.to(code).emit('game-phase-update', { phase: 'waiting' });
            
            setTimeout(() => {
                startInitialVotingPhase(code);
            }, 3000);
        }
    }, 5000);
}

function endGame(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('game-ended', {
        finalScores: gameState.scores
    });
}

function startTimer(code, seconds, callback) {
    const gameState = gameStates.get(code);
    if (!gameState) return;
    
    gameState.timer = seconds;
    
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    gameState.timerInterval = setInterval(() => {
        gameState.timer--;
        io.to(code).emit('game-timer', { timeRemaining: gameState.timer });
        
        if (gameState.timer <= 0) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
            callback();
        }
    }, 1000);
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Make sure to create a never_have_i_ever_topics.txt file with "Never have I ever" statements (one per line)');
});