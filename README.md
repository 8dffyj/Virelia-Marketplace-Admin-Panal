# VV Balance Editor - Setup Guide

A Node.js web application with Discord OAuth authentication for managing VV balances in MongoDB.

## Prerequisites

- Node.js (v14 or higher)
- MongoDB running locally or remotely
- Discord Application and Bot

## Installation

1. **Clone or create the project directory:**
```bash
mkdir vv-balance-editor
cd vv-balance-editor
```

2. **Install dependencies:**
```bash
npm install
```

3. **Create the views directory structure:**
```bash
mkdir views
```

## Discord Application Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Give it a name (e.g., "VV Balance Editor")
4. Go to the "OAuth2" section

### 2. Configure OAuth2

1. In "Redirects", add: `http://localhost:3000/auth/discord/callback`
2. In "OAuth2 URL Generator":
   - Select scopes: `identify` and `guilds`
   - Copy the generated URL for testing

### 3. Create Discord Bot

1. Go to "Bot" section
2. Click "Add Bot"
3. Copy the bot token
4. Enable "Server Members Intent" if you need to check user roles

### 4. Add Bot to Your Server

1. Use the OAuth2 URL with `bot` scope and necessary permissions
2. Add the bot to your Discord server

## Environment Configuration

Create a `.env` file in your project root with the following variables:

```env
# Discord OAuth Application Settings
DISCORD_CLIENT_ID=your_discord_client_id_here
DISCORD_CLIENT_SECRET=your_discord_client_secret_here
DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback

# Discord Bot Token (needed to check user roles)
DISCORD_BOT_TOKEN=your_bot_token_here

# Discord Server Settings
DISCORD_GUILD_ID=your_discord_server_id
REQUIRED_ROLE_ID=your_required_role_id

# MongoDB Connection
MONGODB_URI=mongodb://localhost:27017/virelia

# Session Secret (generate a random string)
SESSION_SECRET=your_random_secret_key_here

# Server Port
PORT=3000
```

### How to Get Discord IDs

**Server ID (Guild ID):**
1. Enable Developer Mode in Discord (User Settings > Advanced > Developer Mode)
2. Right-click your server name → Copy ID

**Role ID:**
1. In your Discord server, go to Server Settings → Roles
2. Right-click the role you want to use → Copy ID

**User ID (for testing):**
1. Right-click on a user → Copy ID

## MongoDB Setup

Make sure your MongoDB is running and accessible. The application will connect to the `virelia` database and use the `USER` collection (which should already exist based on your image).

The USER schema should match this structure:
```javascript
{
  _id: String,           // Discord User ID
  username: String,      // Discord username
  avatar: String,        // Discord avatar hash
  email: String,         // User email
  discord: Object,       // Discord data
  last_login: Date,      // Last login timestamp
  updated_at: Date,      // Last update timestamp
  vv_balance: Number,    // VV Balance (this is what we edit)
  created_at: Date       // Creation timestamp
}
```

## Running the Application

1. **Development mode (with auto-restart):**
```bash
npm run dev
```

2. **Production mode:**
```bash
npm start
```

3. **Access the application:**
   - Open your browser and go to `http://localhost:3000`

## Usage

1. **Login:** Click "Login with Discord" to authenticate
2. **Role Check:** The app automatically verifies if you have the required role
3. **Dashboard:** View all users and their current VV balances
4. **Edit Balance:** Click "Edit Balance" next to any user to modify their VV balance
5. **Save Changes:** The balance is immediately updated in MongoDB

## Features

- ✅ Discord OAuth authentication
- ✅ Role-based access control
- ✅ MongoDB integration
- ✅ Real-time balance editing
- ✅ User search and sorting
- ✅ Responsive Bootstrap UI
- ✅ Balance change preview
- ✅ Error handling

## Security Features

- Session-based authentication
- Role verification before allowing access
- Input validation for balance updates
- Error handling for unauthorized access

## Troubleshooting

### Common Issues

1. **"Error verifying Discord permissions"**
   - Check if your bot token is correct
   - Ensure the bot is in your Discord server
   - Verify the guild ID and role ID are correct

2. **"Server configuration error"**
   - Make sure all environment variables are set
   - Check that DISCORD_GUILD_ID and REQUIRED_ROLE_ID are defined

3. **MongoDB connection issues**
   - Verify MongoDB is running
   - Check the MONGODB_URI in your .env file
   - Ensure the database name matches ("virelia")

4. **OAuth callback issues**
   - Verify the callback URL matches in both Discord app settings and .env
   - For production, update the callback URL accordingly

### Debug Mode

To enable debug logging, add this to your .env:
```env
DEBUG=*
```

## Production Deployment

For production deployment:

1. **Update environment variables:**
   - Change `DISCORD_CALLBACK_URL` to your production domain
   - Update the Discord application's OAuth2 redirect URIs
   - Use a secure `SESSION_SECRET`

2. **Use process manager:**
```bash
npm install -g pm2
pm2 start app.js --name "vv-balance-editor"
```

3. **Set up reverse proxy (nginx):**
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## License

This project is for personal/internal use. Make sure to comply with Discord's Terms of Service and API guidelines.