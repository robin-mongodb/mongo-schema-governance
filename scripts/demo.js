const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DB_NAME = "schema_governance_demo";
const COLLECTION = "customer";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("Set MONGODB_URI environment variable first.");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(DB_NAME);

  try {
    // CLEAN SLATE
    console.log("\n--- Dropping collection for a clean demo ---\n");
    await db
      .collection(COLLECTION)
      .drop()
      .catch(() => {});

    // STEP 1: Write and apply v1 schema
    console.log("=== STEP 1: Apply v1 Avro schema ===\n");

    const v1Avro = {
      type: "record",
      name: "Customer",
      namespace: "com.natwest.customer",
      doc: "Schema for FSI customer documents - v1",
      fields: [
        { name: "firstName", type: "string", doc: "Customer's first name" },
        { name: "lastName", type: "string", doc: "Customer's last name" },
        { name: "email", type: "string", doc: "Customer's email address" },
        {
          name: "accountType",
          type: {
            type: "enum",
            name: "AccountType",
            symbols: ["SAVINGS", "CURRENT", "ISA"],
          },
          doc: "Type of bank account",
        },
        { name: "balance", type: "double", doc: "Current account balance" },
        {
          name: "address",
          type: {
            type: "record",
            name: "Address",
            fields: [
              { name: "line1", type: "string", doc: "Street address" },
              { name: "city", type: "string", doc: "City" },
              { name: "postcode", type: "string", doc: "Postcode" },
            ],
          },
          doc: "Customer's address",
        },
      ],
    };

    const schemaPath = path.join(__dirname, "..", "schemas", "customer.avsc");
    fs.writeFileSync(schemaPath, JSON.stringify(v1Avro, null, 2));
    execSync(
      `node ${path.join(__dirname, "avro-to-mongo-validator.js")} ${schemaPath} customer`,
      { stdio: "inherit" },
    );

    const v1Validator = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "generated", "customer-validator.json"),
        "utf-8",
      ),
    );

    await db.createCollection(COLLECTION, {
      validator: v1Validator.validator,
      validationLevel: "strict",
      validationAction: "error",
    });
    console.log("v1 schema validation applied.\n");

    // STEP 2: Insert a valid v1 document
    console.log("=== STEP 2: Insert a valid v1 document ===\n");

    const v1Doc = {
      firstName: "Jane",
      lastName: "Smith",
      email: "jane.smith@natwest.co.uk",
      accountType: "ISA",
      balance: 15000.5,
      address: {
        line1: "10 Downing Street",
        city: "London",
        postcode: "SW1A 2AA",
      },
    };
    console.log(JSON.stringify(v1Doc, null, 2));

    const result1 = await db.collection(COLLECTION).insertOne(v1Doc);
    console.log(`\nINSERT SUCCEEDED — _id: ${result1.insertedId}\n`);

    // STEP 3: Evolve schema to v2 — add required kycStatus
    console.log('=== STEP 3: Evolve to v2 — adding required "kycStatus" ===\n');

    const v2Avro = JSON.parse(JSON.stringify(v1Avro));
    v2Avro.doc = "Schema for FSI customer documents - v2 (added KYC status)";
    v2Avro.fields.push({
      name: "kycStatus",
      type: {
        type: "enum",
        name: "KYCStatus",
        symbols: ["PENDING", "VERIFIED", "REJECTED"],
      },
      doc: "Know Your Customer verification status",
    });

    fs.writeFileSync(schemaPath, JSON.stringify(v2Avro, null, 2));
    execSync(
      `node ${path.join(__dirname, "avro-to-mongo-validator.js")} ${schemaPath} customer`,
      { stdio: "inherit" },
    );

    const v2Validator = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "generated", "customer-validator.json"),
        "utf-8",
      ),
    );

    await db.command(v2Validator);
    console.log("v2 schema validation applied.\n");

    // STEP 4: Try inserting a v1 document — should FAIL
    console.log(
      "=== STEP 4: Insert v1 document (missing kycStatus) — should FAIL ===\n",
    );

    const v1DocAgain = {
      firstName: "John",
      lastName: "Doe",
      email: "john.doe@natwest.co.uk",
      accountType: "CURRENT",
      balance: 5000.5,
      address: {
        line1: "1 Canada Square",
        city: "London",
        postcode: "E14 5AB",
      },
    };
    console.log(JSON.stringify(v1DocAgain, null, 2));

    try {
      await db.collection(COLLECTION).insertOne(v1DocAgain);
      console.log("\nThis should not have succeeded!");
    } catch (err) {
      console.log(`\nINSERT FAILED (as expected!)`);
      console.log(`Error: ${err.message}\n`);
    }

    // STEP 5: Insert a valid v2 document — should SUCCEED
    console.log("=== STEP 5: Insert valid v2 document (with kycStatus) ===\n");

    const v2Doc = {
      firstName: "John",
      lastName: "Doe",
      email: "john.doe@natwest.co.uk",
      accountType: "CURRENT",
      balance: 5000.5,
      address: {
        line1: "1 Canada Square",
        city: "London",
        postcode: "E14 5AB",
      },
      kycStatus: "VERIFIED",
    };
    console.log(JSON.stringify(v2Doc, null, 2));

    const result2 = await db.collection(COLLECTION).insertOne(v2Doc);
    console.log(`\nINSERT SUCCEEDED — _id: ${result2.insertedId}\n`);

    // SUMMARY
    console.log("=== DEMO COMPLETE ===\n");
    console.log("v1 document under v1 schema  → ACCEPTED");
    console.log("v1 document under v2 schema  → REJECTED (missing kycStatus)");
    console.log("v2 document under v2 schema  → ACCEPTED");
  } finally {
    await client.close();
  }
}

main().catch(console.error);
