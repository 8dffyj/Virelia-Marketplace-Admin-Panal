// app.js - Virelia Discord User Management System
// Ar734 - Advanced User Management Panel for Discord Communities

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const Strategy = require('passport-discord');
const mongoose = require('mongoose');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();

// ==================== MONGODB SETUP ====================
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// User Schema
const userSchema = new mongoose.Schema({
  _id: String, // Discord ID
  username: String,
  avatar: String,
  email: String,
  vv_balance: { type: Number, default: 0 },
  in_server: { type: Boolean, default: false },
  server_roles: [String],
  discord_tokens: {
    access_token: String,
    refresh_token: String,
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  last_login: Date,
});

const User = mongoose.model('User', userSchema);

// Webhook Log Schema
const webhookLogSchema = new mongoose.Schema({
  event_type: String,
  action: String,
  user_id: String,
  data: mongoose.Schema.Types.Mixed,
  webhook_sent: { type: Boolean, default: false },
  retry_count: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  sent_at: Date,
  error: String,
});

const WebhookLog = mongoose.model('WebhookLog', webhookLogSchema);

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));

app.use(passport.initialize());
app.use(passport.session());

// ==================== PASSPORT SETUP ====================
passport.use(new Strategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ['identify', 'email', 'guilds.members.read'],
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findById(profile.id);
    const userData = {
      _id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      email: profile.email,
      discord_tokens: { access_token: accessToken, refresh_token: refreshToken },
      updated_at: new Date(),
      last_login: new Date(),
    };

    if (user) {
      await User.findByIdAndUpdate(profile.id, userData, { new: true });
    } else {
      userData.created_at = new Date();
      user = await User.create(userData);
    }

    await logWebhook('USER_LOGIN', `User ${profile.username} logged in`, profile.id, { username: profile.username });
    done(null, user);
  } catch (error) {
    console.error('Passport Error:', error);
    done(error);
  }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

// ==================== HELPER FUNCTIONS ====================
async function logWebhook(eventType, action, userId, data) {
  try {
    const log = new WebhookLog({
      event_type: eventType,
      action,
      user_id: userId,
      data,
    });
    await log.save();
    await sendWebhook(log);
  } catch (error) {
    console.error('Webhook Log Error:', error);
  }
}

async function sendWebhook(log, retryCount = 0) {
  if (retryCount > 5) {
    await WebhookLog.findByIdAndUpdate(log._id, { error: 'Max retries exceeded' });
    return;
  }

  try {
    const colorMap = {
      USER_LOGIN: 0x00ff00,
      USER_CREATED: 0x0099ff,
      USER_UPDATED: 0xffaa00,
      BALANCE_UPDATED: 0xff6600,
      SERVER_SYNC: 0x6600ff,
      ERROR: 0xff0000,
    };

    const embed = {
      title: log.event_type,
      description: log.action,
      color: colorMap[log.event_type] || 0x808080,
      fields: [
        { name: 'User ID', value: log.user_id || 'N/A', inline: true },
        { name: 'Timestamp', value: new Date(log.created_at).toISOString(), inline: true },
      ],
      footer: { text: 'Virelia System • Ar734' },
    };

    await axios.post(process.env.WEBHOOK_URL, { embeds: [embed] });
    await WebhookLog.findByIdAndUpdate(log._id, {
      webhook_sent: true,
      sent_at: new Date(),
    });
  } catch (error) {
    const delay = Math.pow(2, retryCount) * 1000;
    setTimeout(() => sendWebhook(log, retryCount + 1), delay);
    await WebhookLog.findByIdAndUpdate(log._id, {
      retry_count: retryCount + 1,
      error: error.message,
    });
  }
}

function isAdmin(req) {
  if (!req.user) return false;
  return req.user.server_roles.includes(process.env.REQUIRED_ROLE_ID);
}

// ==================== AUTH ROUTES ====================
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/dashboard')
);

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.redirect('/dashboard');
    res.redirect('/');
  });
});

// ==================== MAIN ROUTES ====================
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('index');
});

app.get('/dashboard', async (req, res) => {
  if (!req.user) return res.redirect('/');

  try {
    const allUsers = await User.find();
    const dbUsers = allUsers.filter(u => u.created_at);
    const serverOnlyUsers = allUsers.filter(u => u.in_server && !u.created_at);
    const onlineUsers = allUsers.filter(u => u.last_login && (Date.now() - u.last_login) < 30 * 60 * 1000);

    res.render('dashboard', {
      user: req.user,
      allUsers,
      dbUsers,
      serverOnlyUsers,
      onlineUsers,
      isAdmin: isAdmin(req),
      stats: {
        total: allUsers.length,
        db_users: dbUsers.length,
        server_only: serverOnlyUsers.length,
        online: onlineUsers.length,
      },
    });
  } catch (error) {
    res.render('error', { error: error.message });
  }
});

app.get('/edit/:id', async (req, res) => {
  if (!req.user || !isAdmin(req)) return res.render('error', { error: 'Unauthorized' });

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.render('error', { error: 'User not found' });

    res.render('edit', { user, admin: true });
  } catch (error) {
    res.render('error', { error: error.message });
  }
});

app.post('/edit/:id', async (req, res) => {
  if (!req.user || !isAdmin(req)) return res.json({ success: false, error: 'Unauthorized' });

  try {
    const { username, email, vv_balance } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, {
      username,
      email,
      vv_balance: parseInt(vv_balance),
      updated_at: new Date(),
    }, { new: true });

    await logWebhook('USER_UPDATED', `User ${user.username} updated`, user._id, {
      username,
      email,
      vv_balance,
    });

    res.json({ success: true, user });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/update-balance/:id', async (req, res) => {
  if (!req.user || !isAdmin(req)) return res.json({ success: false, error: 'Unauthorized' });

  try {
    const { vv_balance } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, {
      vv_balance: parseInt(vv_balance),
      updated_at: new Date(),
    }, { new: true });

    await logWebhook('BALANCE_UPDATED', `Balance updated to ${vv_balance}`, user._id, { vv_balance });
    res.json({ success: true, user });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ==================== SERVER SYNC ====================
app.post('/sync-server', async (req, res) => {
  if (!req.user || !isAdmin(req)) return res.json({ success: false, error: 'Unauthorized' });

  try {
    const headers = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
    let allMembers = [];
    let after = '0';
    let newCount = 0, updatedCount = 0;

    // Fetch all server members
    while (true) {
      const response = await axios.get(
        `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members?limit=1000&after=${after}`,
        { headers }
      );
      if (response.data.length === 0) break;
      allMembers = allMembers.concat(response.data);
      after = response.data[response.data.length - 1].user.id;
    }

    for (const member of allMembers) {
      const userId = member.user.id;
      const user = await User.findById(userId);

      if (!user) {
        await User.create({
          _id: userId,
          username: member.user.username,
          avatar: member.user.avatar,
          email: member.user.email,
          in_server: true,
          server_roles: member.roles,
          created_at: new Date(),
          updated_at: new Date(),
        });
        newCount++;
      } else {
        await User.findByIdAndUpdate(userId, {
          username: member.user.username,
          avatar: member.user.avatar,
          email: member.user.email,
          in_server: true,
          server_roles: member.roles,
          updated_at: new Date(),
        });
        updatedCount++;
      }
    }

    await logWebhook('SERVER_SYNC', `Server sync completed`, 'SYSTEM', {
      new_members: newCount,
      updated_members: updatedCount,
      total_members: allMembers.length,
    });

    res.json({
      success: true,
      new_members: newCount,
      updated_members: updatedCount,
      total_members: allMembers.length,
    });
  } catch (error) {
    await logWebhook('ERROR', `Sync error: ${error.message}`, 'SYSTEM', {});
    res.json({ success: false, error: error.message });
  }
});

app.get('/logs', async (req, res) => {
  if (!req.user || !isAdmin(req)) return res.render('error', { error: 'Unauthorized' });

  try {
    const logs = await WebhookLog.find().sort({ created_at: -1 }).limit(50);
    res.render('logs', { logs });
  } catch (error) {
    res.render('error', { error: error.message });
  }
});

app.post('/retry-webhooks', async (req, res) => {
  if (!req.user || !isAdmin(req)) return res.json({ success: false, error: 'Unauthorized' });

  try {
    const failedLogs = await WebhookLog.find({ webhook_sent: false });
    for (const log of failedLogs) {
      await sendWebhook(log);
    }
    res.json({ success: true, retried: failedLogs.length });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ==================== STARTUP ====================
async function syncServerOnStartup() {
  try {
    const headers = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
    const response = await axios.get(
      `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members?limit=1000`,
      { headers }
    );

    for (const member of response.data) {
      const userId = member.user.id;
      const existingUser = await User.findById(userId);

      if (!existingUser) {
        await User.create({
          _id: userId,
          username: member.user.username,
          avatar: member.user.avatar,
          in_server: true,
          server_roles: member.roles,
        });
      }
    }
    console.log('✅ Initial server sync completed');
  } catch (error) {
    console.error('❌ Startup sync error:', error.message);
  }
}

setInterval(async () => {
  try {
    const failedLogs = await WebhookLog.find({ webhook_sent: false, retry_count: { $lt: 5 } });
    for (const log of failedLogs) {
      await sendWebhook(log, log.retry_count);
    }
  } catch (error) {
    console.error('Retry loop error:', error);
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Virelia running on port ${PORT}`);
  await syncServerOnStartup();
});