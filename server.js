const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_CODE = 'java';
const PORT = 3000;

let serverCounter = 1;
const gameServers = new Map(); // id -> GameServer
const players = new Map();     // socketId -> playerData

// ── Spawn Positions ──────────────────────────────────────────────────────────
const RED_SPAWNS  = [[-20,1.2,-22],[-18,1.2,-24],[-22,1.2,-19],[-17,1.2,-21]];
const BLUE_SPAWNS = [[ 20,1.2,-22],[ 18,1.2,-24],[ 22,1.2,-19],[ 17,1.2,-21]];

function randomSpawn(team) {
  const pool = team === 'red' ? RED_SPAWNS : BLUE_SPAWNS;
  const [x,y,z] = pool[Math.floor(Math.random() * pool.length)];
  return { x, y, z };
}

// ── Game Server Class ─────────────────────────────────────────────────────────
class GameServer {
  constructor(id, name, maxPlayers) {
    this.id = id;
    this.name = name;
    this.maxPlayers = Math.min(16, Math.max(2, maxPlayers || 10));
    this.players = new Map();
    this.createdAt = Date.now();
  }
  info() {
    return {
      id: this.id,
      name: this.name,
      maxPlayers: this.maxPlayers,
      count: this.players.size,
      playerList: Array.from(this.players.values()).map(p => ({
        id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths
      }))
    };
  }
}

function broadcastServers() {
  io.emit('serverList', Array.from(gameServers.values()).map(s => s.info()));
}

// ── Socket Handlers ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);
  broadcastServers();

  // ─ Admin ─
  socket.on('adminAuth', ({ code }, cb) => cb?.({ ok: code === ADMIN_CODE }));

  socket.on('adminCreateServer', ({ code, name, maxPlayers }, cb) => {
    if (code !== ADMIN_CODE) return cb?.({ err: 'Bad code' });
    const id = `srv${serverCounter++}`;
    gameServers.set(id, new GameServer(id, name || `Server ${serverCounter}`, maxPlayers));
    broadcastServers();
    cb?.({ ok: true, id });
    console.log(`[ADMIN] Created server: ${name}`);
  });

  socket.on('adminDeleteServer', ({ code, serverId }, cb) => {
    if (code !== ADMIN_CODE) return cb?.({ err: 'Bad code' });
    const gs = gameServers.get(serverId);
    if (!gs) return cb?.({ err: 'Not found' });
    gs.players.forEach((_, sid) => io.to(sid).emit('forcedLeave', 'Server closed by admin'));
    gameServers.delete(serverId);
    broadcastServers();
    cb?.({ ok: true });
  });

  socket.on('adminKick', ({ code, targetId }, cb) => {
    if (code !== ADMIN_CODE) return cb?.({ err: 'Bad code' });
    io.to(targetId).emit('forcedLeave', 'Kicked by admin');
    handleLeave(targetId);
    cb?.({ ok: true });
  });

  socket.on('adminSetMax', ({ code, serverId, max }, cb) => {
    if (code !== ADMIN_CODE) return cb?.({ err: 'Bad code' });
    const gs = gameServers.get(serverId);
    if (gs) { gs.maxPlayers = Math.min(16, Math.max(2, max)); broadcastServers(); }
    cb?.({ ok: true });
  });

  socket.on('adminGetServers', ({ code }, cb) => {
    if (code !== ADMIN_CODE) return cb?.({ err: 'Bad code' });
    cb?.({ servers: Array.from(gameServers.values()).map(s => s.info()) });
  });

  // ─ Lobby ─
  socket.on('joinServer', ({ serverId, playerName }, cb) => {
    const gs = gameServers.get(serverId);
    if (!gs)                     return cb?.({ err: 'Server not found' });
    if (gs.players.size >= gs.maxPlayers) return cb?.({ err: 'Server full' });

    let red = 0, blue = 0;
    gs.players.forEach(p => p.team === 'red' ? red++ : blue++);
    const team = red <= blue ? 'red' : 'blue';
    const spawnPos = randomSpawn(team);

    const pd = {
      id: socket.id,
      name: (playerName || '').trim() || `Soldier_${socket.id.slice(0,4)}`,
      serverId,
      team,
      position: spawnPos,
      rotY: team === 'red' ? 0 : Math.PI,
      health: 100,
      weapon: 'assault',
      kills: 0,
      deaths: 0,
      alive: true
    };

    gs.players.set(socket.id, pd);
    players.set(socket.id, pd);
    socket.join(serverId);

    const others = Array.from(gs.players.values()).filter(p => p.id !== socket.id);
    socket.emit('joinedServer', { myPlayer: pd, others, serverInfo: gs.info() });
    socket.to(serverId).emit('peerJoined', pd);
    broadcastServers();
    cb?.({ ok: true });
    console.log(`[JOIN] ${pd.name} (${team}) -> ${gs.name}`);
  });

  socket.on('leaveServer', () => handleLeave(socket.id));

  // ─ Game ─
  socket.on('playerUpdate', data => {
    const p = players.get(socket.id);
    if (!p) return;
    p.position = data.position;
    p.rotY     = data.rotY;
    p.weapon   = data.weapon;
    const gs = gameServers.get(p.serverId);
    if (gs?.players.has(socket.id)) Object.assign(gs.players.get(socket.id), {
      position: data.position, rotY: data.rotY, weapon: data.weapon
    });
    socket.to(p.serverId).emit('peerUpdate', {
      id: socket.id,
      position: data.position,
      rotY: data.rotY,
      weapon: data.weapon,
      alive: p.alive
    });
  });

  socket.on('playerShoot', data => {
    const p = players.get(socket.id);
    if (!p) return;
    socket.to(p.serverId).emit('peerShoot', { id: socket.id, weapon: data.weapon });
  });

  socket.on('hitPlayer', ({ targetId, damage, weapon }) => {
    const att = players.get(socket.id);
    if (!att?.serverId) return;
    const gs = gameServers.get(att.serverId);
    if (!gs) return;
    const tgt = gs.players.get(targetId);
    if (!tgt || !tgt.alive || tgt.team === att.team) return;

    tgt.health = Math.max(0, tgt.health - damage);
    io.to(targetId).emit('tookDamage', { health: tgt.health, by: socket.id, weapon });
    socket.emit('hitConfirmed', { targetId, hp: tgt.health });

    if (tgt.health <= 0) {
      tgt.alive = false;
      tgt.deaths++;
      att.kills++;
      if (gs.players.has(socket.id)) gs.players.get(socket.id).kills = att.kills;

      io.to(att.serverId).emit('elimination', {
        killerId:   socket.id,
        killerName: att.name,
        victimId:   targetId,
        victimName: tgt.name,
        weapon,
        killerKills: att.kills
      });

      io.to(targetId).emit('youDied', { by: att.name, respawnIn: 3 });

      setTimeout(() => {
        const gs2 = gameServers.get(att.serverId);
        const t2  = gs2?.players.get(targetId);
        if (!t2) return;
        const pos = randomSpawn(t2.team);
        t2.health = 100; t2.alive = true; t2.position = pos;
        const tp  = players.get(targetId);
        if (tp) { tp.health = 100; tp.alive = true; tp.position = pos; }
        io.to(targetId).emit('youRespawned', { position: pos });
        io.to(att.serverId).emit('peerRespawned', { id: targetId, position: pos });
      }, 3000);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    handleLeave(socket.id);
  });

  function handleLeave(sid) {
    const p = players.get(sid);
    if (p?.serverId) {
      const gs = gameServers.get(p.serverId);
      if (gs) {
        gs.players.delete(sid);
        io.to(p.serverId).emit('peerLeft', sid);
      }
      io.sockets.sockets.get(sid)?.leave(p.serverId);
    }
    players.delete(sid);
    broadcastServers();
  }
});

httpServer.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║   🎮 FPS BATTLE SERVER       ║`);
  console.log(`║   http://localhost:${PORT}     ║`);
  console.log(`║   Admin Code: java           ║`);
  console.log(`╚══════════════════════════════╝\n`);
});
