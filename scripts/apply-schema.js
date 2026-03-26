const { MongoClient } = require("mongodb");
const fs = require("fs");

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      "Usage: node apply-schema.js <validator.json> <databaseName>",
    );
    process.exit(1);
  }

  const validatorCommand = JSON.parse(fs.readFileSync(args[0], "utf-8"));
  const dbName = args[1];
  const collectionName = validatorCommand.collMod;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI environment variable is not set.");
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db(dbName);

    // Create collection if it doesn't exist
    const collections = await db
      .listCollections({ name: collectionName })
      .toArray();
    if (collections.length === 0) {
      await db.createCollection(collectionName);
      console.log(`Collection "${collectionName}" created.`);
    }

    // Apply schema validation
    await db.command(validatorCommand);
    console.log(
      `Schema validation applied to "${collectionName}" in "${dbName}"`,
    );
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
