'use strict';

// Isolated PostgreSQL connector for Employee Access Control.
// No connection is attempted unless DATABASE_URL is configured.
// Initialization failures must not take down the existing sales dashboard.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
let initialization = null;
const state = {
  configured: Boolean(process.env.DATABASE_URL),
  ready: false,
  lastError: null
};

function getAccessControlPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000
    });
    pool.on('error', () => {
      state.ready = false;
      state.lastError = 'PostgreSQL connection error';
    });
  }
  return pool;
}

async function initializeAccessControlDatabase() {
  if (!process.env.DATABASE_URL) {
    state.configured = false;
    state.ready = false;
    return { configured: false, ready: false };
  }
  if (initialization) return initialization;

  initialization = (async () => {
    state.configured = true;
    state.lastError = null;
    const db = getAccessControlPool();
    const schemaPath = path.join(__dirname, 'postgres-schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await db.query(schema);
    state.ready = true;
    return { configured: true, ready: true };
  })().catch(error => {
    state.ready = false;
    state.lastError = 'PostgreSQL initialization failed';
    initialization = null;
    // Do not return connection strings, credentials, or raw DB errors to clients.
    console.error('Employee Access Control database initialization failed:', error.message);
    throw error;
  });

  return initialization;
}

function getAccessControlDatabaseStatus() {
  return {
    configured: Boolean(process.env.DATABASE_URL),
    ready: state.ready,
    lastError: state.lastError
  };
}

module.exports = {
  getAccessControlPool,
  initializeAccessControlDatabase,
  getAccessControlDatabaseStatus
};
