// Migration script to add timestamps to existing data
// Run this once to add createdAt properties to existing nodes and relationships

const migrateTimestamps = async (driver) => {
  const session = driver.session();
  try {
    console.log('Starting timestamp migration...');
    
    // Add createdAt to nodes that don't have it
    const nodeResult = await session.run(
      `MATCH (u:User)
       WHERE u.createdAt IS NULL
       SET u.createdAt = $timestamp
       RETURN count(u) as updatedNodes`,
      { timestamp: Date.now() }
    );
    

    
    // Add createdAt to relationships that don't have it
    const relResult = await session.run(
      `MATCH ()-[r:CONNECTED_TO]->()
       WHERE r.createdAt IS NULL
       SET r.createdAt = $timestamp
       RETURN count(r) as updatedRelationships`,
      { timestamp: Date.now() }
    );
    

    

    
  } catch (error) {
    console.error('Error during timestamp migration:', error);
  } finally {
    session.close();
  }
};

export default migrateTimestamps;
