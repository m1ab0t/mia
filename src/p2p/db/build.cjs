const path = require('path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const SCHEMA_DIR = path.join(__dirname, 'schema')
const DB_DIR = path.join(__dirname, 'spec')

// Hyperschema definitions
const schema = Hyperschema.from(SCHEMA_DIR)
const kin = schema.namespace('kin')

kin.register({
  name: 'conversation',
  compact: true,
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: true },
    { name: 'createdAt', type: 'uint', required: true },
    { name: 'updatedAt', type: 'uint', required: true }
  ]
})

kin.register({
  name: 'message',
  compact: true,
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'conversationId', type: 'string', required: true },
    { name: 'type', type: 'string', required: true },
    { name: 'content', type: 'string', required: true },
    { name: 'timestamp', type: 'uint', required: true },
    { name: 'toolName', type: 'string' },
    { name: 'toolInput', type: 'string' },
    { name: 'toolResult', type: 'string' },
    { name: 'toolStatus', type: 'string' },
    { name: 'routeInfo', type: 'string' },
    { name: 'toolExecutions', type: 'string' },
    { name: 'metadata', type: 'string' }
  ]
})

Hyperschema.toDisk(schema)

// Hyperdb collection definitions
const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
const kinDB = db.namespace('kin')

kinDB.require(path.join(__dirname, 'helpers.cjs'))

kinDB.collections.register({
  name: 'conversations',
  schema: '@kin/conversation',
  key: ['id']
})

kinDB.collections.register({
  name: 'messages',
  schema: '@kin/message',
  key: ['id']
})

// Index messages by conversation + timestamp for ordered retrieval within a conversation
kinDB.indexes.register({
  name: 'messages-by-conversation',
  collection: '@kin/messages',
  unique: false,
  key: {
    type: {
      fields: [
        { name: 'conversationId', type: 'string' },
        { name: 'timestamp', type: 'uint' }
      ]
    },
    map: 'mapMessageToConversation'
  }
})

HyperDB.toDisk(db)

console.log('HyperDB schema built successfully')
