/* ============================================
   NeoFragrances — create a LOCAL admin account
   Usage (from neofragrances-server):  npm run create-local-admin

   Development tool only. It refuses to run in production, on Render,
   or against any database that isn't on this machine. The password is
   typed at a hidden prompt — it is never passed as an argument,
   printed, or logged — and only its bcrypt hash is stored.
   ============================================ */

require("dotenv").config({ quiet: true });
const readline = require("readline");
const bcrypt = require("bcrypt");

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
const MIN_PASSWORD_LENGTH = 8;

function refuse(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production" || process.env.RENDER) refuse("Refusing to run: this looks like a production environment.");
if (!LOCAL_HOSTS.includes(String(process.env.DB_HOST || "").trim())) refuse("Refusing to run: DB_HOST is not a local database.");
if (!process.stdin.isTTY) refuse("Run this in an interactive terminal so the password can be typed privately.");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = question => new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));

// Hidden input: echo nothing while the password is typed.
function askHidden(question) {
  return new Promise(resolve => {
    const write = rl._writeToOutput;
    rl.output.write(question);
    rl._writeToOutput = () => {};
    rl.question("", answer => {
      rl._writeToOutput = write;
      rl.output.write("\n");
      resolve(answer);
    });
  });
}

(async () => {
  const pool = require("../db");
  try {
    console.log(`\nCreate a local NeoFragrances admin (database "${process.env.DB_NAME}" on ${process.env.DB_HOST}).\n`);
    const fullName = await ask("Full name: ");
    if (fullName.length < 2 || fullName.length > 150) refuse("Full name must be 2–150 characters.");
    const email = (await ask("Email: ")).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) refuse("Please enter a valid email address.");
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length) refuse("An account with that email already exists. Use a different email for the admin account.");

    const password = await askHidden(`Password (min ${MIN_PASSWORD_LENGTH} characters, hidden): `);
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) refuse(`Password must be ${MIN_PASSWORD_LENGTH}–200 characters.`);
    const confirm = await askHidden("Confirm password (hidden): ");
    if (confirm !== password) refuse("Passwords don't match.");

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role, auth_provider, email_verified_at)
       VALUES (?, ?, ?, 'admin', 'local', NOW())`,
      [fullName, email, hash]
    );
    console.log(`\n✔ Local admin created (user id ${result.insertId}). Sign in at admin/login.html.\n`);
  } catch (err) {
    refuse(`Could not create the admin: ${err.message}`);
  } finally {
    rl.close();
    await pool.end().catch(() => {});
  }
})();
