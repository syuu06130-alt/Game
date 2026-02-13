const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// 管理パスコード（必要に応じて変更）
const ADMIN_CODE = 'admin123';

// サーバー一覧（メモリ保存）
let servers = [];
let nextServerId = 1;

// プレイヤー管理（id -> データ）
const players = new Map();

// ユーティリティ: ランダムなチーム割り当て
function getRandomTeam() {
  return Math.random() < 0.5 ? 'red' : 'blue';
}

// サーバー一覧を全クライアントに送信
function broadcastServerList() {
  io.emit('serverList', servers.map(s => ({
    id: s.id,
    name: s.name,
    count: s.players.length,
    maxPlayers: s.maxPlayers,
    playerList: s.players.map(pid => players.get(pid)).filter(p => p)
  })));
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // 新規プレイヤー仮登録
  players.set(socket.id, { id: socket.id, name: 'Unknown', team: 'red', kills: 0, deaths: 0 });

  // サーバー一覧要求
  socket.on('serverList', () => {
    broadcastServerList();
  });

  // 管理者認証
  socket.on('adminAuth', ({ code }, callback) => {
    callback({ ok: code === ADMIN_CODE });
  });

  // サーバー作成（管理者のみ）
  socket.on('adminCreateServer', ({ code, name, maxPlayers }, callback) => {
    if (code !== ADMIN_CODE) return callback({ err: 'Unauthorized' });
    const newServer = {
      id: `srv_${nextServerId++}`,
      name: name || 'New Server',
      maxPlayers: maxPlayers || 10,
      players: []
    };
    servers.push(newServer);
    broadcastServerList();
    callback({ ok: true });
  });

  // サーバー削除（管理者）
  socket.on('adminDeleteServer', ({ code, serverId }) => {
    if (code !== ADMIN_CODE) return;
    servers = servers.filter(s => s.id !== serverId);
    // そのサーバーにいたプレイヤーを追い出す（簡易）
    broadcastServerList();
  });

  // サーバー最大プレイヤー数変更（管理者）
  socket.on('adminSetMax', ({ code, serverId, max }) => {
    if (code !== ADMIN_CODE) return;
    const srv = servers.find(s => s.id === serverId);
    if (srv) srv.maxPlayers = max;
    broadcastServerList();
  });

  // キック（管理者）
  socket.on('adminKick', ({ code, targetId }) => {
    if (code !== ADMIN_CODE) return;
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('forcedLeave', 'Kicked by admin');
      targetSocket.disconnect();
    }
  });

  // サーバー参加
  socket.on('joinServer', ({ serverId, playerName }, callback) => {
    const srv = servers.find(s => s.id === serverId);
    if (!srv) return callback({ err: 'Server not found' });
    if (srv.players.length >= srv.maxPlayers) return callback({ err: 'Server full' });

    // 以前のサーバーから離脱
    servers.forEach(s => {
      const idx = s.players.indexOf(socket.id);
      if (idx !== -1) s.players.splice(idx, 1);
    });

    srv.players.push(socket.id);
    const player = players.get(socket.id) || { id: socket.id };
    player.name = playerName || 'Anonymous';
    player.team = getRandomTeam();
    player.kills = 0;
    player.deaths = 0;
    player.position = { x: 0, y: 1.2, z: 0 };
    player.rotY = 0;
    player.weapon = 'assault';
    player.alive = true;
    players.set(socket.id, player);

    // 同じサーバーの他プレイヤー一覧
    const others = srv.players
      .filter(id => id !== socket.id)
      .map(id => players.get(id))
      .filter(p => p);

    socket.join(`srv_${serverId}`);
    socket.emit('joinedServer', { myPlayer: player, others, serverInfo: srv });
    socket.to(`srv_${serverId}`).emit('peerJoined', player);

    broadcastServerList();
    callback({ ok: true });
  });

  // プレイヤー更新（位置、回転など）
  socket.on('playerUpdate', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    Object.assign(player, data);
    // 同じサーバー内にブロードキャスト
    const srv = servers.find(s => s.players.includes(socket.id));
    if (srv) {
      socket.to(`srv_${srv.id}`).emit('peerUpdate', { id: socket.id, ...data });
    }
  });

  // プレイヤー射撃通知
  socket.on('playerShoot', (data) => {
    const srv = servers.find(s => s.players.includes(socket.id));
    if (srv) {
      socket.to(`srv_${srv.id}`).emit('peerShoot', { id: socket.id, ...data });
    }
  });

  // ヒット通知（ダメージ計算はサーバーで行うべきだが、簡易版）
  socket.on('hitPlayer', ({ targetId, damage, weapon }) => {
    const target = players.get(targetId);
    if (!target || !target.alive) return;
    // 実際のダメージ計算（本来はサーバーで管理すべき）
    target.health = (target.health || 100) - damage;
    if (target.health <= 0) {
      target.alive = false;
      target.deaths = (target.deaths || 0) + 1;
      const attacker = players.get(socket.id);
      if (attacker) attacker.kills = (attacker.kills || 0) + 1;

      // 死亡通知
      io.to(targetId).emit('youDied', { by: attacker?.name || 'unknown', respawnIn: 3 });
      // 他プレイヤーに死を知らせる
      const srv = servers.find(s => s.players.includes(socket.id) || s.players.includes(targetId));
      if (srv) {
        io.to(`srv_${srv.id}`).emit('peerRespawned', { id: targetId, position: { x: 0, y: 1.2, z: 0 } }); // 仮
        io.to(`srv_${srv.id}`).emit('elimination', {
          killerId: socket.id,
          killerName: attacker?.name,
          victimId: targetId,
          victimName: target.name,
          weapon,
          killerKills: attacker?.kills
        });
      }

      // 3秒後にリスポーン
      setTimeout(() => {
        if (players.has(targetId)) {
          target.alive = true;
          target.health = 100;
          target.position = { x: Math.random() * 20 - 10, y: 1.2, z: Math.random() * 20 - 10 };
          io.to(targetId).emit('youRespawned', { position: target.position });
          const srv2 = servers.find(s => s.players.includes(targetId));
          if (srv2) {
            io.to(`srv_${srv2.id}`).emit('peerRespawned', { id: targetId, position: target.position });
          }
        }
      }, 3000);
    } else {
      // ダメージ通知
      socket.emit('tookDamage', { health: target.health, by: socket.id, weapon });
      socket.emit('hitConfirmed', { targetId, hp: target.health });
    }
  });

  // チャット
  socket.on('chatMsg', ({ msg }) => {
    const player = players.get(socket.id);
    if (!player) return;
    const srv = servers.find(s => s.players.includes(socket.id));
    if (srv) {
      io.to(`srv_${srv.id}`).emit('chatMsg', { name: player.name, msg, team: player.team });
    }
  });

  // 切断処理
  socket.on('disconnect', () => {
    console.log('disconnected:', socket.id);
    players.delete(socket.id);
    servers.forEach(s => {
      const idx = s.players.indexOf(socket.id);
      if (idx !== -1) {
        s.players.splice(idx, 1);
        io.to(`srv_${s.id}`).emit('peerLeft', socket.id);
      }
    });
    broadcastServerList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
