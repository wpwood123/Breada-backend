import admin from "firebase-admin";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// 🧩 Recreate __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!admin.apps.length) {
  const serviceAccountPath = path.resolve(__dirname, "../breada-firebase-service-account.json");

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath),
  });
}

export default admin;

