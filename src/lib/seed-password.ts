// Run this with: npx tsx src/lib/seed-password.ts "yourpassword"
// to generate the hash for the seed script.
import bcrypt from "bcryptjs";
const password = process.argv[2] ?? "demo1234";
console.log("Hash:", bcrypt.hashSync(password, 10));
