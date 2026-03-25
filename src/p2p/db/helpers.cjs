exports.mapMessageToConversation = (record) => {
  if (!record.conversationId || !record.timestamp) return []
  return [{ conversationId: record.conversationId, timestamp: record.timestamp }]
}
