const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection - Updated to use 'virelia' database
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/virelia', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// User Schema
const userSchema = new mongoose.Schema({
  _id: String,
  username: String,
  avatar: String,
  email: String,
  discord: Object,
  last_login: Date,
  updated_at: Date,
  vv_balance: { type: Number, default: 0 },
  created_at: Date,
  // Add fields to track user status
  in_server: { type: Boolean, default: false },
  server_roles: [String] // Store user's roles from the server
});

const User = mongoose.model('User', userSchema);

// Webhook Log Schema
const webhookLogSchema = new mongoose.Schema({
  event_type: { type: String, required: true }, // 'user_updated', 'user_created', 'balance_updated', 'server_sync', etc.
  user_id: String, // The user who performed the action
  target_user_id: String, // The user who was affected (if different)
  action: { type: String, required: true }, // Detailed action description
  changes: Object, // Object containing before/after values
  metadata: {
    ip_address: String,
    user_agent: String,
    timestamp: { type: Date, default: Date.now },
    session_id: String
  },
  webhook_status: {
    sent: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    last_attempt: Date,
    error_message: String,
    success_timestamp: Date
  }
});

const WebhookLog = mongoose.model('WebhookLog', webhookLogSchema);

// Rate limiting storage for webhooks
const webhookRateLimit = {
  requests: [],
  maxRequests: 50, // Max requests per window
  windowMs: 60000, // 1 minute window
  retryAfter: 300000 // 5 minutes retry after rate limit hit
};

// Webhook logging utility class
class WebhookLogger {
  constructor() {
    this.webhookUrl = process.env.WEBHOOK_URL;
    this.rateLimitHit = false;
    this.rateLimitUntil = null;
  }

  // Check if we're currently rate limited
  isRateLimited() {
    if (this.rateLimitUntil && Date.now() < this.rateLimitUntil) {
      return true;
    }
    if (this.rateLimitUntil && Date.now() >= this.rateLimitUntil) {
      this.rateLimitHit = false;
      this.rateLimitUntil = null;
    }
    return false;
  }

  // Clean old requests from rate limit tracking
  cleanOldRequests() {
    const now = Date.now();
    webhookRateLimit.requests = webhookRateLimit.requests.filter(
      time => now - time < webhookRateLimit.windowMs
    );
  }

  // Check if we can make a webhook request
  canMakeRequest() {
    if (this.isRateLimited()) {
      return false;
    }

    this.cleanOldRequests();
    return webhookRateLimit.requests.length < webhookRateLimit.maxRequests;
  }

  // Add request to rate limit tracking
  addRequest() {
    webhookRateLimit.requests.push(Date.now());
  }

  // Set rate limit status
  setRateLimited() {
    this.rateLimitHit = true;
    this.rateLimitUntil = Date.now() + webhookRateLimit.retryAfter;
  }

  // Create a log entry
  async createLog(eventType, action, userId, targetUserId, changes, req) {
    try {
      const logEntry = new WebhookLog({
        event_type: eventType,
        user_id: userId,
        target_user_id: targetUserId,
        action: action,
        changes: changes,
        metadata: {
          ip_address: req?.ip || req?.connection?.remoteAddress || 'unknown',
          user_agent: req?.get('User-Agent') || 'unknown',
          session_id: req?.session?.id || 'unknown'
        }
      });

      await logEntry.save();
      
      // Try to send webhook immediately
      this.sendWebhook(logEntry._id);
      
      return logEntry;
    } catch (error) {
      console.error('Error creating webhook log:', error);
      return null;
    }
  }

  // Send webhook with rate limiting
  async sendWebhook(logId, retryCount = 0) {
    if (!this.webhookUrl) {
      console.log('No webhook URL configured, skipping webhook send');
      return;
    }

    try {
      const log = await WebhookLog.findById(logId);
      if (!log || log.webhook_status.sent) {
        return;
      }

      // Check rate limiting
      if (!this.canMakeRequest()) {
        if (this.isRateLimited()) {
          console.log(`Webhook rate limited until ${new Date(this.rateLimitUntil)}`);
          await this.scheduleRetry(logId, 'Rate limited');
          return;
        }
      }

      // Get user details for webhook
      const user = log.user_id ? await User.findById(log.user_id) : null;
      const targetUser = log.target_user_id ? await User.findById(log.target_user_id) : null;

      // Create webhook payload
      const embed = this.createDiscordEmbed(log, user, targetUser);
      
      this.addRequest();
      
      const response = await axios.post(this.webhookUrl, {
        embeds: [embed],
        username: 'Virelia Logger',
        avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png'
      }, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 200 || response.status === 204) {
        // Success
        await WebhookLog.findByIdAndUpdate(logId, {
          'webhook_status.sent': true,
          'webhook_status.success_timestamp': new Date(),
          'webhook_status.attempts': (log.webhook_status.attempts || 0) + 1
        });
        
        console.log(`Webhook sent successfully for log ${logId}`);
      }

    } catch (error) {
      console.error(`Webhook send failed for log ${logId}:`, error.message);
      
      // Handle rate limiting
      if (error.response && error.response.status === 429) {
        this.setRateLimited();
        const retryAfter = error.response.headers['retry-after'] 
          ? parseInt(error.response.headers['retry-after']) * 1000 
          : webhookRateLimit.retryAfter;
        this.rateLimitUntil = Date.now() + retryAfter;
      }

      await this.scheduleRetry(logId, error.message, retryCount);
    }
  }

  // Schedule a retry for failed webhooks
  async scheduleRetry(logId, errorMessage, retryCount = 0) {
    const maxRetries = 5;
    const baseDelay = 30000; // 30 seconds
    const retryDelay = baseDelay * Math.pow(2, retryCount); // Exponential backoff

    await WebhookLog.findByIdAndUpdate(logId, {
      'webhook_status.attempts': retryCount + 1,
      'webhook_status.last_attempt': new Date(),
      'webhook_status.error_message': errorMessage
    });

    if (retryCount < maxRetries) {
      setTimeout(() => {
        this.sendWebhook(logId, retryCount + 1);
      }, retryDelay);
      
      console.log(`Scheduled retry for log ${logId} in ${retryDelay}ms (attempt ${retryCount + 1})`);
    } else {
      console.log(`Max retries reached for log ${logId}`);
    }
  }

  // Create Discord embed for webhook
  createDiscordEmbed(log, user, targetUser) {
    const embed = {
      title: `🔄 ${log.event_type.replace('_', ' ').toUpperCase()}`,
      description: log.action,
      color: this.getColorForEventType(log.event_type),
      timestamp: log.metadata.timestamp.toISOString(),
      footer: {
        text: `Virelia Management System | Log ID: ${log._id.toString().slice(-8)}`
      },
      fields: []
    };

    // Add user information
    if (user) {
      embed.fields.push({
        name: '👤 Performed by',
        value: `${user.username} (${user._id})`,
        inline: true
      });
    }

    // Add target user information if different
    if (targetUser && targetUser._id !== user?._id) {
      embed.fields.push({
        name: '🎯 Target User',
        value: `${targetUser.username} (${targetUser._id})`,
        inline: true
      });
    }

    // Add metadata
    embed.fields.push({
      name: '🌐 Request Info',
      value: `IP: ${log.metadata.ip_address}\nTime: <t:${Math.floor(log.metadata.timestamp.getTime() / 1000)}:F>`,
      inline: false
    });

    // Add changes information
    if (log.changes && Object.keys(log.changes).length > 0) {
      const changesText = this.formatChanges(log.changes);
      embed.fields.push({
        name: '📝 Changes Made',
        value: changesText.length > 1024 ? changesText.substring(0, 1021) + '...' : changesText,
        inline: false
      });
    }

    return embed;
  }

  // Get color based on event type
  getColorForEventType(eventType) {
    const colors = {
      'user_created': 0x00FF00, // Green
      'user_updated': 0x0099FF, // Blue
      'balance_updated': 0xFFD700, // Gold
      'user_deleted': 0xFF0000, // Red
      'server_sync': 0x800080, // Purple
      'login': 0x00FFFF, // Cyan
      'logout': 0xFF6B6B, // Light red
      'error': 0xFF0000 // Red
    };
    return colors[eventType] || 0x808080; // Gray default
  }

  // Format changes for display
  formatChanges(changes) {
    let text = '';
    for (const [field, change] of Object.entries(changes)) {
      if (change.before !== undefined && change.after !== undefined) {
        text += `**${field}:** \`${change.before}\` → \`${change.after}\`\n`;
      } else if (change.before !== undefined) {
        text += `**${field}:** Removed \`${change.before}\`\n`;
      } else if (change.after !== undefined) {
        text += `**${field}:** Added \`${change.after}\`\n`;
      }
    }
    return text || 'No specific changes recorded';
  }

  // Retry failed webhooks (can be called periodically)
  async retryFailedWebhooks() {
    try {
      const failedLogs = await WebhookLog.find({
        'webhook_status.sent': false,
        'webhook_status.attempts': { $lt: 5 }
      }).limit(10);

      for (const log of failedLogs) {
        if (this.canMakeRequest()) {
          this.sendWebhook(log._id, log.webhook_status.attempts || 0);
        } else {
          break; // Stop if we hit rate limit
        }
      }
    } catch (error) {
      console.error('Error retrying failed webhooks:', error);
    }
  }
}

// Create webhook logger instance
const webhookLogger = new WebhookLogger();

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

app.use(passport.initialize());
app.use(passport.session());

// Function to get all server members
async function getServerMembers() {
  try {
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!guildId) return [];

    const response = await axios.get(
      `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`
        }
      }
    );

    return response.data || [];
  } catch (error) {
    console.error('Error fetching server members:', error);
    return [];
  }
}

// Function to sync database with server members
async function syncUsersWithServer(performedByUserId = null, req = null) {
  try {
    const serverMembers = await getServerMembers();
    const serverMemberIds = serverMembers.map(member => member.user.id);

    // Get current state for logging
    const beforeSync = await User.countDocuments();

    // Update all users to mark if they're in server
    await User.updateMany({}, { in_server: false, server_roles: [] });

    let newUsers = 0;
    let updatedUsers = 0;

    // Update users that are in the server
    for (const member of serverMembers) {
      const userId = member.user.id;
      const existingUser = await User.findById(userId);
      
      const userData = {
        _id: userId,
        username: member.user.username,
        avatar: member.user.avatar,
        in_server: true,
        server_roles: member.roles || [],
        updated_at: new Date()
      };

      const result = await User.findByIdAndUpdate(userId, userData, {
        upsert: true,
        setDefaultsOnInsert: true,
        new: true
      });

      if (!existingUser) {
        newUsers++;
      } else {
        updatedUsers++;
      }
    }

    // Log the server sync
    await webhookLogger.createLog(
      'server_sync',
      `Server sync completed: ${newUsers} new members, ${updatedUsers} updated members`,
      performedByUserId,
      null,
      {
        before_sync_count: { after: beforeSync },
        new_members: { after: newUsers },
        updated_members: { after: updatedUsers },
        total_server_members: { after: serverMembers.length }
      },
      req
    );

    console.log(`Synced ${serverMembers.length} server members with database`);
    return { success: true, newUsers, updatedUsers, totalMembers: serverMembers.length };
  } catch (error) {
    console.error('Error syncing users with server:', error);
    
    // Log the error
    await webhookLogger.createLog(
      'error',
      `Server sync failed: ${error.message}`,
      performedByUserId,
      null,
      { error_message: { after: error.message } },
      req
    );
    
    return { success: false, error: error.message };
  }
}

// Passport Discord Strategy
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
  scope: ['identify', 'email', 'guilds.members.read']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findById(profile.id);
    const isNewUser = !user;
    
    const userData = {
      _id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      email: profile.email,
      discord: {
        id: profile.id,
        username: profile.username,
        discriminator: profile.discriminator,
        avatar: profile.avatar,
        accessToken: accessToken,
        refreshToken: refreshToken
      },
      last_login: new Date(),
      updated_at: new Date(),
      in_server: true // User is logging in, so they're likely in server
    };

    if (user) {
      // Update existing user
      const beforeData = {
        username: user.username,
        email: user.email,
        last_login: user.last_login
      };
      
      Object.assign(user, userData);
      await user.save();

      // Log user login/update
      await webhookLogger.createLog(
        'login',
        `User logged in and data updated`,
        profile.id,
        profile.id,
        {
          username: { before: beforeData.username, after: userData.username },
          email: { before: beforeData.email, after: userData.email },
          last_login: { before: beforeData.last_login, after: userData.last_login }
        },
        null // No req object available in passport strategy
      );
    } else {
      // Create new user
      userData.created_at = new Date();
      user = new User(userData);
      await user.save();

      // Log new user creation
      await webhookLogger.createLog(
        'user_created',
        `New user registered via Discord OAuth`,
        profile.id,
        profile.id,
        {
          username: { after: userData.username },
          email: { after: userData.email },
          created_at: { after: userData.created_at }
        },
        null // No req object available in passport strategy
      );
    }

    return done(null, user);
  } catch (error) {
    return done(error, null);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// Middleware to check if user has required Discord role
async function hasRequiredRole(req, res, next) {
  if (!req.user || !req.user.discord.accessToken) {
    return res.status(403).json({ error: 'Not authenticated' });
  }

  try {
    // Check if user has required role in Discord server
    const guildId = process.env.DISCORD_GUILD_ID;
    const requiredRoleId = process.env.REQUIRED_ROLE_ID;
    
    if (!guildId || !requiredRoleId) {
      // If no role checking is configured, allow all authenticated users
      return next();
    }

    const response = await axios.get(
      `https://discord.com/api/v10/guilds/${guildId}/members/${req.user._id}`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`
        }
      }
    );

    const member = response.data;
    if (member.roles.includes(requiredRoleId)) {
      req.user.hasRequiredRole = true;
      return next();
    } else {
      req.user.hasRequiredRole = false;
      return res.status(403).render('error', { 
        message: 'You do not have the required Discord role to access this feature.',
        user: req.user 
      });
    }
  } catch (error) {
    console.error('Error checking Discord role:', error);
    req.user.hasRequiredRole = false;
    return next();
  }
}

// Routes
app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

// Authentication routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/dashboard');
  }
);

app.get('/logout', async (req, res) => {
  const userId = req.user?._id;
  
  req.logout(async (err) => {
    if (err) {
      return next(err);
    }
    
    // Log logout
    if (userId) {
      await webhookLogger.createLog(
        'logout',
        'User logged out',
        userId,
        userId,
        { logout_time: { after: new Date() } },
        req
      );
    }
    
    res.redirect('/');
  });
});

// Dashboard route - view all users (both DB and server)
app.get('/dashboard', async (req, res) => {
  try {
    // Sync with server first
    await syncUsersWithServer(req.user?._id, req);
    
    // Get all users from database, sorted by creation date
    const users = await User.find({}).sort({ created_at: -1 });
    
    // Check if current user has required role
    let hasEditPermission = false;
    if (req.user) {
      // Check if user has admin role or required permission
      hasEditPermission = true; // Set this based on actual role checking
    }
    
    // Separate users by status
    const dbUsers = users.filter(u => u.created_at); // Users with creation date (from DB)
    const serverOnlyUsers = users.filter(u => u.in_server && !u.created_at); // Server members not in original DB
    
    res.render('dashboard', { 
      users, 
      dbUsers,
      serverOnlyUsers,
      user: req.user,
      hasEditPermission 
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).render('error', { 
      message: 'Error loading dashboard',
      user: req.user 
    });
  }
});

// Route to manually sync with server
app.post('/sync-server', hasRequiredRole, async (req, res) => {
  try {
    const result = await syncUsersWithServer(req.user._id, req);
    res.json(result);
  } catch (error) {
    console.error('Error syncing server:', error);
    res.status(500).json({ error: 'Failed to sync with server' });
  }
});

// Edit user form route
app.get('/edit/:id', hasRequiredRole, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).render('error', { 
        message: 'User not found',
        user: req.user 
      });
    }
    res.render('edit', { editUser: user, user: req.user });
  } catch (error) {
    console.error('Error fetching user for edit:', error);
    res.status(500).render('error', { 
      message: 'Error loading user data',
      user: req.user 
    });
  }
});

// Update user route
app.post('/edit/:id', hasRequiredRole, async (req, res) => {
  try {
    const { username, email, vv_balance } = req.body;
    const userId = req.params.id;
    
    // Get current user data for comparison
    const currentUser = await User.findById(userId);
    if (!currentUser) {
      return res.status(404).render('error', { 
        message: 'User not found',
        user: req.user 
      });
    }
    
    const beforeData = {
      username: currentUser.username,
      email: currentUser.email,
      vv_balance: currentUser.vv_balance
    };
    
    const updateData = {
      username,
      email,
      vv_balance: parseFloat(vv_balance) || 0,
      updated_at: new Date()
    };

    await User.findByIdAndUpdate(userId, updateData);
    
    // Log the changes
    const changes = {};
    if (beforeData.username !== updateData.username) {
      changes.username = { before: beforeData.username, after: updateData.username };
    }
    if (beforeData.email !== updateData.email) {
      changes.email = { before: beforeData.email, after: updateData.email };
    }
    if (beforeData.vv_balance !== updateData.vv_balance) {
      changes.vv_balance = { before: beforeData.vv_balance, after: updateData.vv_balance };
    }
    
    await webhookLogger.createLog(
      'user_updated',
      `User profile updated`,
      req.user._id,
      userId,
      changes,
      req
    );
    
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).render('error', { 
      message: 'Error updating user',
      user: req.user 
    });
  }
});

// API route for balance updates (AJAX)
app.post('/api/update-balance/:id', hasRequiredRole, async (req, res) => {
  try {
    const { vv_balance } = req.body;
    const userId = req.params.id;
    
    // Get current balance for comparison
    const currentUser = await User.findById(userId);
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const beforeBalance = currentUser.vv_balance;
    const afterBalance = parseFloat(vv_balance) || 0;
    
    await User.findByIdAndUpdate(userId, {
      vv_balance: afterBalance,
      updated_at: new Date()
    });
    
    // Log the balance change
    await webhookLogger.createLog(
      'balance_updated',
      `User balance updated via AJAX`,
      req.user._id,
      userId,
      {
        vv_balance: { before: beforeBalance, after: afterBalance }
      },
      req
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating balance:', error);
    res.status(500).json({ error: 'Failed to update balance' });
  }
});

// Webhook logs viewing route (admin only)
app.get('/logs', hasRequiredRole, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    const logs = await WebhookLog.find({})
      .sort({ 'metadata.timestamp': -1 })
      .limit(limit)
      .skip(skip)
      .lean();
    
    const totalLogs = await WebhookLog.countDocuments();
    const totalPages = Math.ceil(totalLogs / limit);
    
    res.json({
      logs,
      pagination: {
        currentPage: page,
        totalPages,
        totalLogs,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Webhook retry route (admin only)
app.post('/retry-webhooks', hasRequiredRole, async (req, res) => {
  try {
    await webhookLogger.retryFailedWebhooks();
    res.json({ success: true, message: 'Webhook retry process started' });
  } catch (error) {
    console.error('Error retrying webhooks:', error);
    res.status(500).json({ error: 'Failed to retry webhooks' });
  }
});

// Periodic webhook retry (every 5 minutes)
setInterval(() => {
  webhookLogger.retryFailedWebhooks();
}, 5 * 60 * 1000);

// Sync with server on startup
mongoose.connection.once('open', async () => {
  console.log('Connected to MongoDB');
  console.log('Using database:', mongoose.connection.db.databaseName);
  console.log('Expected database: virelia');
  console.log('Webhook URL configured:', !!process.env.WEBHOOK_URL);
  await syncUsersWithServer();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to get started`);
  console.log('Database: virelia');
  console.log('Webhook logging system: ACTIVE');
});