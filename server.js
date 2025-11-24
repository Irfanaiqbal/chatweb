const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const MemoryStore = require('memorystore')(session); // Fixed session store

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Session configuration - FIXED for production with proper store
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({
    checkPeriod: 86400000 // prune expired entries every 24h
  }),
  cookie: { 
    secure: false, // Set to true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin credentials
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'ghost@5555';

// Data storage
let waitingUser = null;
let onlineUsers = new Map();
let activeRooms = new Map();
let adminConnections = new Set();
let messageCount = 0;

// Utility functions
function updateOnlineCount() {
  io.emit('updateOnlineCount', onlineUsers.size);
  // Also send to admin panel specifically
  notifyAdmins('onlineCountUpdate', onlineUsers.size);
}

function notifyAdmins(event, data) {
  adminConnections.forEach(adminId => {
    io.to(adminId).emit(event, data);
  });
}

function getActiveRoomsData() {
  const rooms = [];
  activeRooms.forEach((room, roomId) => {
    // Only include rooms that still have active users
    const activeRoomUsers = room.users.filter(userId => onlineUsers.has(userId));
    if (activeRoomUsers.length > 0) {
      rooms.push({
        id: roomId,
        users: activeRoomUsers,
        createdAt: room.createdAt
      });
    } else {
      // Remove empty rooms
      activeRooms.delete(roomId);
    }
  });
  return rooms;
}

function createRoom(user1, user2) {
  const roomId = `room-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const room = {
    id: roomId,
    users: [user1, user2],
    createdAt: new Date()
  };
  activeRooms.set(roomId, room);
  return roomId;
}

function removeUserFromRoom(userId) {
  let roomFound = null;
  activeRooms.forEach((room, roomId) => {
    if (room.users.includes(userId)) {
      roomFound = room;
      room.users = room.users.filter(id => id !== userId);
      if (room.users.length === 0) {
        activeRooms.delete(roomId);
      }
    }
  });
  return roomFound;
}

function cleanupEmptyRooms() {
  activeRooms.forEach((room, roomId) => {
    const activeUsers = room.users.filter(userId => onlineUsers.has(userId));
    if (activeUsers.length === 0) {
      activeRooms.delete(roomId);
    }
  });
}

function sendAdminUpdate() {
  cleanupEmptyRooms(); // Clean up before sending data
  const adminData = {
    onlineUsers: Array.from(onlineUsers.values()),
    waitingUser: waitingUser,
    activeRooms: getActiveRoomsData(),
    stats: {
      totalOnline: onlineUsers.size,
      totalRooms: activeRooms.size,
      waitingUsers: waitingUser ? 1 : 0,
      totalMessages: messageCount
    }
  };
  
  console.log('Sending admin update:', {
    onlineUsers: adminData.onlineUsers.length,
    activeRooms: adminData.activeRooms.length,
    stats: adminData.stats
  });
  
  adminConnections.forEach(adminId => {
    io.to(adminId).emit('adminData', adminData);
  });
}

// Force send admin update every 5 seconds for testing
setInterval(() => {
  if (adminConnections.size > 0) {
    console.log('Auto-sending admin update to', adminConnections.size, 'admins');
    sendAdminUpdate();
  }
}, 5000);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Serve admin-login.html directly
app.get('/admin-login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Admin routes - FIXED session handling
app.get('/admin', (req, res) => {
  console.log('Admin access check - Session:', req.sessionID);
  if (!req.session.isAdmin) {
    console.log('Redirecting to login - not admin');
    return res.redirect('/admin-login.html');
  }
  console.log('Admin access granted for session:', req.sessionID);
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  console.log('Login attempt for user:', username);
  
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    console.log('Admin login successful - Session:', req.sessionID);
    return res.redirect('/admin');
  } else {
    console.log('Admin login failed');
    return res.redirect('/admin-login.html?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    console.log('Admin logged out');
    res.redirect('/admin-login.html');
  });
});

// Debug endpoint to check sessions
app.get('/debug-session', (req, res) => {
  res.json({
    session: req.session,
    sessionID: req.sessionID,
    onlineUsers: onlineUsers.size,
    adminConnections: adminConnections.size,
    waitingUser: waitingUser,
    activeRooms: activeRooms.size
  });
});

// Socket.io connection handling - FIXED IP detection for Render
io.on('connection', (socket) => {
  // FIXED: Better IP detection for cloud platforms
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];
  const realIP = socket.handshake.headers['x-real-ip'];
  const socketIP = socket.handshake.address;
  
  let userIP;
  if (forwardedFor) {
    userIP = forwardedFor.split(',')[0].trim();
  } else if (realIP) {
    userIP = realIP;
  } else {
    userIP = socketIP;
  }
  
  // Handle IPv6 format
  if (userIP && userIP.includes('::ffff:')) {
    userIP = userIP.replace('::ffff:', '');
  }
  
  const userInfo = {
    id: socket.id,
    ip: userIP || 'Unknown IP',
    connectedAt: new Date(),
    room: null,
    status: 'waiting'
  };
  
  onlineUsers.set(socket.id, userInfo);
  console.log(`User connected: ${socket.id} from IP: ${userIP}`);
  console.log(`Total online users: ${onlineUsers.size}`);
  
  updateOnlineCount();
  sendAdminUpdate();

  // Handle user matching
  if (waitingUser && waitingUser !== socket.id) {
    const partnerSocket = io.sockets.sockets.get(waitingUser);
    if (partnerSocket && onlineUsers.has(waitingUser)) {
      // Create room for both users
      const roomId = createRoom(socket.id, waitingUser);
      
      socket.join(roomId);
      partnerSocket.join(roomId);
      
      // Update user info
      userInfo.room = roomId;
      userInfo.status = 'chatting';
      onlineUsers.get(waitingUser).room = roomId;
      onlineUsers.get(waitingUser).status = 'chatting';
      
      // Notify users
      socket.emit('status', { 
        message: 'You are connected to a stranger! Start chatting...', 
        clear: true,
        connected: true 
      });
      partnerSocket.emit('status', { 
        message: 'You are connected to a stranger! Start chatting...', 
        clear: true,
        connected: true 
      });
      
      waitingUser = null;
      
      sendAdminUpdate();
      
      console.log(`Room created: ${roomId} for users: ${socket.id}, ${waitingUser}`);
    } else {
      // Partner no longer available
      waitingUser = null;
    }
  }
  
  if (!userInfo.room) {
    socket.emit('status', { 
      message: 'Searching for a stranger...', 
      clear: true,
      connected: false 
    });
    waitingUser = socket.id;
    sendAdminUpdate();
  }

  // Handle messages
  socket.on('sendMessage', (message) => {
    if (userInfo.room && message.trim()) {
      messageCount++;
      const room = activeRooms.get(userInfo.room);
      if (room) {
        socket.to(userInfo.room).emit('receiveMessage', message);
        sendAdminUpdate(); // Update admin when message is sent
      }
    }
  });

  // Handle typing indicators
  socket.on('typing', (isTyping) => {
    if (userInfo.room) {
      socket.to(userInfo.room).emit('typing', isTyping);
    }
  });

  // Handle skip chat
  socket.on('skipChat', () => {
    console.log(`Skip chat requested by: ${socket.id}`);
    
    const previousRoom = userInfo.room;
    
    if (previousRoom) {
      socket.leave(previousRoom);
      removeUserFromRoom(socket.id);
      
      // Notify partner
      const room = activeRooms.get(previousRoom);
      if (room && room.users.length > 0) {
        const partnerId = room.users[0];
        const partnerSocket = io.sockets.sockets.get(partnerId);
        if (partnerSocket) {
          partnerSocket.emit('status', {
            message: 'Your partner has left. Searching for new stranger...',
            clear: true,
            connected: false
          });
          partnerSocket.leave(previousRoom);
          onlineUsers.get(partnerId).room = null;
          onlineUsers.get(partnerId).status = 'waiting';
          
          // Add partner back to waiting if not already waiting
          if (!waitingUser) {
            waitingUser = partnerId;
            partnerSocket.emit('status', {
              message: 'Searching for a stranger...',
              clear: true,
              connected: false
            });
          }
        }
      }
    }
    
    // Update current user
    userInfo.room = null;
    userInfo.status = 'waiting';
    
    // Handle waiting user logic
    if (waitingUser === socket.id) {
      waitingUser = null;
    }
    
    if (!waitingUser) {
      waitingUser = socket.id;
      socket.emit('status', {
        message: 'Searching for a stranger...',
        clear: true,
        connected: false
      });
    } else if (waitingUser !== socket.id) {
      const partnerSocket = io.sockets.sockets.get(waitingUser);
      if (partnerSocket && onlineUsers.has(waitingUser)) {
        const roomId = createRoom(socket.id, waitingUser);
        
        socket.join(roomId);
        partnerSocket.join(roomId);
        
        userInfo.room = roomId;
        userInfo.status = 'chatting';
        onlineUsers.get(waitingUser).room = roomId;
        onlineUsers.get(waitingUser).status = 'chatting';
        
        socket.emit('status', {
          message: 'You are connected to a stranger! Start chatting...',
          clear: true,
          connected: true
        });
        partnerSocket.emit('status', {
          message: 'You are connected to a stranger! Start chatting...',
          clear: true,
          connected: true
        });
        
        waitingUser = null;
      } else {
        waitingUser = socket.id;
        socket.emit('status', {
          message: 'Searching for a stranger...',
          clear: true,
          connected: false
        });
      }
    }
    
    sendAdminUpdate();
  });

  // Admin authentication via socket
  socket.on('adminAuth', (password) => {
    console.log('Admin auth attempt via socket');
    if (password === ADMIN_PASSWORD) {
      adminConnections.add(socket.id);
      socket.emit('adminAuthSuccess');
      console.log('Admin socket authentication successful. Total admin connections:', adminConnections.size);
      
      // Send immediate update to this admin
      socket.emit('adminData', {
        onlineUsers: Array.from(onlineUsers.values()),
        waitingUser: waitingUser,
        activeRooms: getActiveRoomsData(),
        stats: {
          totalOnline: onlineUsers.size,
          totalRooms: activeRooms.size,
          waitingUsers: waitingUser ? 1 : 0,
          totalMessages: messageCount
        }
      });
    } else {
      console.log('Admin socket authentication failed');
    }
  });

  // Admin requesting manual refresh
  socket.on('adminRefresh', () => {
    if (adminConnections.has(socket.id)) {
      console.log('Manual admin refresh requested');
      sendAdminUpdate();
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    const disconnectedUser = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    adminConnections.delete(socket.id);
    
    updateOnlineCount();

    // Handle room cleanup
    if (disconnectedUser && disconnectedUser.room) {
      const room = activeRooms.get(disconnectedUser.room);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        
        // Notify partner
        if (room.users.length > 0) {
          const partnerId = room.users[0];
          const partnerSocket = io.sockets.sockets.get(partnerId);
          if (partnerSocket) {
            partnerSocket.emit('status', {
              message: 'Your partner has disconnected. Searching for new stranger...',
              clear: true,
              connected: false
            });
            partnerSocket.leave(disconnectedUser.room);
            onlineUsers.get(partnerId).room = null;
            onlineUsers.get(partnerId).status = 'waiting';
            
            // Add partner to waiting
            if (!waitingUser) {
              waitingUser = partnerId;
              partnerSocket.emit('status', {
                message: 'Searching for a stranger...',
                clear: true,
                connected: false
              });
            }
          }
        }
      }
    }
    
    // Handle waiting user cleanup
    if (waitingUser === socket.id) {
      waitingUser = null;
    }
    
    sendAdminUpdate();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`🔑 Admin credentials: username: 'admin', password: 'ghost@5555'`);
  console.log(`💬 Chat: http://localhost:${PORT}/chat`);
  console.log(`🔐 Admin login: http://localhost:${PORT}/admin-login.html`);
  console.log(`🐛 Debug: http://localhost:${PORT}/debug-session`);
});
