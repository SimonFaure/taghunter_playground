const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let connection = null;
let currentClient = null;

const defaultDbConfig = {
  host: '192.168.129.250',
  port: 3306,
  user: 'bob',
  password: 'WebMaster62',
  database: 'taghunter_playground'
};

function loadSelectedClient() {
  try {
    const configDir = path.join(app.getPath('appData'), 'TagHunterPlayground');
    const selectedClientPath = path.join(configDir, 'selected-client.json');

    if (fs.existsSync(selectedClientPath)) {
      const data = fs.readFileSync(selectedClientPath, 'utf8');
      currentClient = JSON.parse(data);
      return currentClient;
    }
  } catch (error) {
    console.error('Error loading selected client:', error);
  }
  return null;
}

async function connectToDatabase() {
  try {
    const selectedClient = loadSelectedClient();
console.log('in connectToDatabase');
console.log(selectedClient);
    const dbConfig = selectedClient
      ? {
          host: selectedClient.url,
          port: 3306,
          user: 'bob',
          password: 'WebMaster62',
          database: 'taghunter_playground'
        }
      : defaultDbConfig;

    connection = await mysql.createConnection(dbConfig);

    const clientInfo = selectedClient
      ? `${selectedClient.name} (${selectedClient.email})`
      : dbConfig.host;

    console.log('✓ Successfully connected to MySQL database at', clientInfo);
    return {
      success: true,
      message: 'Database connection established',
      client: selectedClient
    };
  } catch (error) {
    console.error('✗ Failed to connect to MySQL database:', error.message);
    return { success: false, message: error.message };
  }
}

async function getConnection() {
  if (!connection) {
    await connectToDatabase();
  }
  return connection;
}

async function closeConnection() {
  if (connection) {
    await connection.end();
    connection = null;
    console.log('Database connection closed');
  }
}

function getCurrentClient() {
  return currentClient;
}

module.exports = {
  connectToDatabase,
  getConnection,
  closeConnection,
  getCurrentClient
};
