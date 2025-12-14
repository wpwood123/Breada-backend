import express from "express";
import type { NextFunction, Request, Response } from "express";
import { PrismaClient, UserRole, TransactionType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { format } from "date-fns"; // optional for CSV date formatting
import { differenceInYears } from "date-fns";
import cors from "cors";
import dotenv from "dotenv";
import admin from "./firebaseAdmin.js";
import { customAlphabet } from "nanoid";
import printQrCodesRoute from "./routes/print-qr-codes.mts";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

// await admin.auth().setCustomUserClaims("5wSNrPgwD8QRRF7H9AsNCSvnoFy1", {
//   role: "admin",
// });

dotenv.config();

const firebaseAdminAuth = admin.auth();
const prisma = new PrismaClient();
const app = express();
const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

// ✅ Enable CORS
app.use(
  cors({
    origin: "https://localhost:5173", // your frontend origin
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true, // optional if you send cookies
  })
);

app.use(express.json());

// -------------------------------------------------------
// Initialize Firebase Admin
// -------------------------------------------------------
// if (process.env.FIREBASE_SERVICE_ACCOUNT) {
//   const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
//   admin.initializeApp({ credential: admin.credential.cert(sa) });
// } else {
//   admin.initializeApp({ credential: admin.credential.applicationDefault() });
// }

// -------------------------------------------------------
// Types
// -------------------------------------------------------
interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    role?: UserRole | string;
  };
}

// -------------------------------------------------------
// Middleware: Verify Firebase JWT
// -------------------------------------------------------
const verifyFirebaseToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toString().startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header" });
  }

  const idToken = authHeader.toString().split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      role: (decoded as any).role || "parent", // default fallback
    };
    next();
  } catch (err) {
    console.error("Token verification error:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// -------------------------------------------------------
// Middleware: Role Authorization
// -------------------------------------------------------
const requireRole = (...allowedRoles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    console.log("Calling requireRole with: ", req.user);
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res
        .status(403)
        .json({ error: "Forbidden: insufficient permissions" });
    }
    next();
  };
};

// -------------------------------------------------------
// Utility Function
// -------------------------------------------------------
function hoursBetween(dateA: Date, dateB: Date): number {
  const ms = Math.abs(dateA.getTime() - dateB.getTime());
  return ms / (1000 * 60 * 60);
}

// -------------------------------------------------------
// GET /api/set-role
// Set the user's firebase claim role
// -------------------------------------------------------
// app.post("/api/set-role", async (req, res) => {
//   const { firebaseUid, role } = req.body;

//   if (!firebaseUid || !role) {
//     return res.status(400).json({ error: "firebaseUid and role are required" });
//   }

//   try {
//     await admin.auth().setCustomUserClaims(firebaseUid, { role });
//     return res.json({ message: "Role claim updated. User must re-login." });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ error: "Failed to set role claim" });
//   }
// });

// -------------------------------------------------------
// GET /api/admin/set-role
// -------------------------------------------------------
app.post(
  "/api/admin/set-role/:userId",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.params.userId;
      const { role } = req.body;

      if (!["parent", "volunteer", "admin"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }

      // 1. Update Prisma role
      await prisma.user.update({
        where: { id: userId },
        data: { role },
      });

      // 2. Update Firebase Custom Claim
      await firebaseAdminAuth.setCustomUserClaims(userId, { role });

      return res.json({ message: "Role updated successfully" });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to update role" });
    }
  }
);

// -------------------------------------------------------
// GET /api/protected
// Validate the user's login
// -------------------------------------------------------
app.get("/api/protected", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.split(" ")[1];
  console.log("Calling /api/protected: ", req);
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    console.log("Authenticated user:", decodedToken.uid);
    res.json({ message: "Protected data access granted" });
  } catch (err) {
    console.error("Invalid token:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
});

// -------------------------------------------------------
// TODO: Forgot Password APIs
// -------------------------------------------------------

// -------------------------------------------------------
// POST /api/users-create
// Creates a new user record in the database
// -------------------------------------------------------
app.post(
  "/api/users-create",
  verifyFirebaseToken,
  async (req: AuthenticatedRequest, res: Response) => {
    console.log("POST api/users-create Request: \n", req.body);
    try {
      const {
        name,
        email,
        phone,
        role = "parent",
        street,
        city,
        state,
        zipCode,
      } = req.body;

      if (!email || !name) {
        return res
          .status(400)
          .json({ error: "Missing required fields: email, name" });
      }

      // ✅ Only admins can create non-parent roles
      if (role !== "parent" && req.user?.role !== "admin") {
        return res
          .status(403)
          .json({ error: "Only admins can assign non-parent roles" });
      }

      // ✅ Check if user already exists
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: "User already exists" });
      }

      // ✅ Create user in Prisma
      const user = await prisma.user.create({
        data: {
          firebaseUid: req.user!.uid,
          name,
          email,
          phone,
          role,
          street,
          city,
          state,
          zipCode,
        },
      });

      // Find the current logged-in Prisma user
      const actingUser = await prisma.user.findUnique({
        where: { firebaseUid: req.user?.uid },
        select: { id: true },
      });

      await prisma.auditLog.create({
        data: {
          userId: actingUser?.id ?? user.id, // fallback if user just created themselves
          action: "create_user",
          entity: "user",
          entityId: user.id,
          details: { createdRole: role },
        },
      });

      return res.status(201).json({
        message: "User created successfully",
        user,
      });
    } catch (err) {
      console.error("Error creating user:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/admin-create
// Creates a new admin
// -------------------------------------------------------
app.post(
  "/api/admin-create",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { firebaseUid, email, name, phone } = req.body;

      if (!firebaseUid) {
        return res
          .status(400)
          .json({ error: "firebaseUid is required to create a user" });
      }

      const user = await prisma.user.create({
        data: {
          firebaseUid,
          email,
          name,
          phone,
          role: "admin",
        },
      });

      res.json({ message: "Admin created", user });
    } catch (err) {
      console.error("Admin creation error:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/admin/create-user
// Allows admins to create new users and set their role
// -------------------------------------------------------
app.post(
  "/api/admin/create-user",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, email, phone, role, street, city, state, zipCode } =
        req.body;
      console.log("Calling api/admin/create-user/ with \n", req.body);
      if (!name || !email || !role) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Create Firebase user
      const firebaseUser = await admin.auth().createUser({
        email,
        displayName: name,
      });

      // Set Firebase custom claims
      await admin.auth().setCustomUserClaims(firebaseUser.uid, { role });

      // Create DB user
      const user = await prisma.user.create({
        data: {
          firebaseUid: firebaseUser.uid,
          email,
          name,
          phone,
          role,
          street: street ?? null,
          city: city ?? null,
          state: state ?? null,
          zipCode: zipCode ?? null,
        },
      });

      return res.json({ message: "User created", user });
    } catch (err) {
      console.error("Error creating user:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/me
// Returns current user
// -------------------------------------------------------
app.get(
  "/api/me",
  verifyFirebaseToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user?.uid) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const dbUser = await prisma.user.findUnique({
        where: { firebaseUid: req.user.uid },
        include: {
          children: true, // optional
        },
      });

      if (!dbUser) {
        return res.status(404).json({ error: "User not found" });
      }

      return res.json(dbUser);
    } catch (err) {
      console.error("Error in /api/me:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// GET /api/users-get-all
// Returns all users in the system
// Only accessible by Admins
// -------------------------------------------------------
app.get(
  "/api/users",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    console.log("calling api/users");
    try {
      // Optional pagination params (future expansion)
      const { limit = 100, offset = 0 } = req.query;

      const users = await prisma.user.findMany({
        skip: Number(offset),
        take: Number(limit),
        include: {
          children: {
            include: { balance: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return res.json({
        count: users.length,
        users,
      });
    } catch (err) {
      console.error("Error fetching users:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// GET /api/child/:childId
// Look up a child by their ID (decoded from QR code)
// -------------------------------------------------------
app.get(
  "/api/child/:childId",
  verifyFirebaseToken,
  requireRole("parent", "volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { childId } = req.params;

      if (!childId) {
        return res.status(400).json({ error: "childId parameter is required" });
      }

      // Get child + parent + balance
      const child = await prisma.child.findUnique({
        where: { id: childId },
        include: {
          parent: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              street: true,
              city: true,
              state: true,
              zipCode: true,
            },
          },
          balance: true,
        },
      });

      if (!child) {
        return res.status(404).json({ error: "Child not found" });
      }

      // If requester is a parent, ensure they can only view *their own* children
      if (req.user?.role === "parent") {
        const parentRecord = await prisma.user.findUnique({
          where: { firebaseUid: req.user.uid },
        });

        if (!parentRecord || parentRecord.id !== child.parentId) {
          return res
            .status(403)
            .json({ error: "You are not allowed to access this child" });
        }
      }

      // Get siblings
      const siblings = await prisma.child.findMany({
        where: {
          parentId: child.parentId,
          id: { not: child.id },
        },
        select: { id: true, name: true },
      });

      return res.json({
        child,
        siblings,
      });
    } catch (err) {
      console.error("Child lookup error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

//--------------------------------------------------------
// TODO: GET /api/user-get-search
// Maybe not needed. Might be easier for the frontend to search and filter
//--------------------------------------------------------

//--------------------------------------------------------
// TODO: GET /api/my-children
// Return the children for a given parent
//--------------------------------------------------------
app.get(
  "/api/my-children",
  verifyFirebaseToken,
  requireRole("parent", "volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    console.log("api/my-children called");
    try {
      const parentUser = await prisma.user.findUnique({
        where: { firebaseUid: req.user!.uid },
      });

      if (!parentUser)
        return res.status(404).json({ error: "Parent not found" });

      const children = await prisma.child.findMany({
        where: { parentId: parentUser.id },
        include: { balance: true },
        orderBy: { name: "asc" },
      });
      //console.log("Returning:", children)
      return res.json(children);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// TODO: POST /api/users-update
// Update a user's information
// User's can update their own information
// Only admins can update information of other users
// -------------------------------------------------------

// -------------------------------------------------------
// TODO: POST /api/user-deactivate
// Deactive a user's account and all children associated
// -------------------------------------------------------

// -------------------------------------------------------
// POST /api/child-create
// Creates a new child and initializes their balance
// -------------------------------------------------------
app.post(
  "/api/child-create",
  verifyFirebaseToken,
  requireRole("parent", "volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, gender, dateOfBirth, parentId: bodyParentId } = req.body;

      if (!name || !gender) {
        return res.status(400).json({
          error: "name and gender are required",
        });
      }

      // 1️⃣ Look up requesting user in DB (by firebase UID)
      const requestingUser = await prisma.user.findUnique({
        where: { firebaseUid: req.user!.uid },
      });

      if (!requestingUser) {
        return res
          .status(404)
          .json({ error: "Requesting user not found in database" });
      }

      let parentIdToUse: string;

      // 2️⃣ Determine allowed behavior based on role
      if (requestingUser.role === "parent") {
        // Parents can only create children for themselves
        parentIdToUse = requestingUser.id;
      } else if (
        requestingUser.role === "volunteer" ||
        requestingUser.role === "admin"
      ) {
        // Admin/Volunteer must specify which parent the child belongs to
        if (!bodyParentId) {
          return res.status(400).json({
            error:
              "parentId is required when creating a child as volunteer/admin",
          });
        }
        parentIdToUse = bodyParentId;
      } else {
        return res.status(403).json({ error: "Invalid role for this action" });
      }

      const dob = dateOfBirth ? new Date(dateOfBirth) : null;

      // 5️⃣ Create Child + Balance atomically
      const result = await prisma.$transaction(async (tx) => {
        const child = await tx.child.create({
          data: {
            parentId: parentIdToUse,
            name,
            gender,
            dateOfBirth: dob,
          },
        });

        const balance = await tx.balance.create({
          data: {
            childId: child.id,
            amountCents: 0,
            lastCheckin: null,
          },
        });

        return { child, balance };
      });

      return res.status(201).json({
        message: "Child created successfully",
        child: result.child,
        balance: result.balance,
      });
    } catch (err) {
      console.error("Child creation error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// TODO: POST /api/child-update
// Update a child's information in the database
// -------------------------------------------------------

// -------------------------------------------------------
// Situation 1: Child Check-In (QR Code Scan)
// POST /api/checkin/:childId
// -------------------------------------------------------
app.post(
  "/api/checkin/:childId",
  verifyFirebaseToken,
  requireRole("volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    console.log(
      "calling api/checkin/:childId \nchildId = ",
      req.params.childId
    );
    console.log("Request.params = ", req.params);
    const { childId } = req.params;
    if (!childId)
      return res.status(400).json({ error: "child ID is required" });

    try {
      const child = await prisma.child.findUnique({
        where: { id: childId },
        include: { parent: true },
      });

      if (!child) return res.status(404).json({ error: "Child not found" });

      const siblings = await prisma.child.findMany({
        where: { parentId: child.parentId, id: { not: child.id } },
        select: {
          id: true,
          name: true,
          dateOfBirth: true,
          timesCheckedIn: true,
        },
      });

      const lastCheckin = await prisma.checkin.findFirst({
        where: { childId: child.id },
        orderBy: { checkinTime: "desc" },
      });

      const now = new Date();
      const cooldownHours = 14;

      if (lastCheckin) {
        const hoursSince = hoursBetween(now, lastCheckin.checkinTime);
        if (hoursSince < cooldownHours) {
          const remaining = +(cooldownHours - hoursSince).toFixed(2);
          return res.status(429).json({
            error: `This user was checked in too recently. Try again in ${remaining} hours`,
          });
        }
      }

      const creditAmount = 200; // $2.00 in cents

      const result = await prisma.$transaction(async (tx) => {
        let balance = await tx.balance.findUnique({
          where: { childId: child.id },
        });
        if (!balance) {
          balance = await tx.balance.create({
            data: { childId: child.id, amountCents: 0 },
          });
        }

        const volunteer = await prisma.user.findUnique({
          where: { firebaseUid: req.user?.uid },
        });

        if (!volunteer) {
          return res
            .status(404)
            .json({ error: "Volunteer not found in database" });
        }

        const checkin = await tx.checkin.create({
          data: {
            childId: child.id,
            volunteerId: volunteer.id,
            checkinTime: now,
            checkinDate: new Date(now.toDateString()),
          },
        });

        const updatedBalance = await tx.balance.update({
          where: { childId: child.id },
          data: {
            amountCents: { increment: creditAmount },
            lastCheckin: now,
            updatedAt: now,
          },
        });

        await tx.child.update({
          where: { id: child.id },
          data: { timesCheckedIn: { increment: 1 } },
        });

        await tx.transaction.create({
          data: {
            childId: child.id,
            type: TransactionType.credit,
            amountCents: creditAmount,
            description: "Daily check-in credit",
          },
        });

        await tx.auditLog.create({
          data: {
            userId: volunteer.id,
            action: "checkin",
            entity: "child",
            entityId: child.id,
            details: { creditedAmount: creditAmount },
          },
        });

        return updatedBalance;
      });

      return res.json({
        message: "Check-in successful",
        child,
        siblings,
        balance: result,
      });
    } catch (err) {
      console.error("Checkin error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// TODO: POST /api/checkin-manual
// -------------------------------------------------------

// -------------------------------------------------------
// POST /api/withdraw
// Situation 2: Withdraw Funds
// -------------------------------------------------------
app.post(
  "/api/withdraw",
  verifyFirebaseToken,
  requireRole("volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    const { childId, amountCents } = req.body;
    if (!childId || typeof amountCents !== "number" || amountCents <= 0)
      return res
        .status(400)
        .json({ error: "childId and a positive amountCents are required" });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const balance = await tx.balance.findUnique({ where: { childId } });
        if (!balance) throw new Error("Balance not found");
        if (balance.amountCents < amountCents)
          throw new Error("Insufficient balance");

        const updatedBalance = await tx.balance.update({
          where: { childId },
          data: {
            amountCents: balance.amountCents - amountCents,
            updatedAt: new Date(),
          },
        });

        const transaction = await tx.transaction.create({
          data: {
            childId,
            type: TransactionType.withdrawal,
            amountCents,
            description: `Withdrawn by ${req.user?.uid}`,
          },
        });

        const volunteer = await prisma.user.findUnique({
          where: { firebaseUid: req.user?.uid },
        });

        if (!volunteer) {
          return res
            .status(404)
            .json({ error: "Volunteer not found in database" });
        }

        await tx.auditLog.create({
          data: {
            userId: volunteer.id,
            action: "withdraw",
            entity: "child",
            entityId: childId,
            details: { amountCents, transactionId: transaction.id },
          },
        });

        return { updatedBalance, transaction };
      });

      return res.json({
        message: "Withdraw successful",
        balance: result.updatedBalance,
        transaction: result.transaction,
      });
    } catch (err: any) {
      console.error("Withdraw error:", err);
      return res
        .status(400)
        .json({ error: err.message || "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/deposit
// Situation 3: Deposit Funds
// -------------------------------------------------------
app.post(
  "/api/deposit",
  verifyFirebaseToken,
  requireRole("volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    console.log("Calling api/deposit \nRequest:", req.body);
    const { childId, amountCents } = req.body;
    if (!childId || typeof amountCents !== "number" || amountCents <= 0)
      return res
        .status(400)
        .json({ error: "childId and a positive amountCents are required" });

    try {
      const result = await prisma.$transaction(async (tx) => {
        let balance = await tx.balance.findUnique({ where: { childId } });
        if (!balance) {
          balance = await tx.balance.create({
            data: { childId, amountCents: 0 },
          });
        }

        const updatedBalance = await tx.balance.update({
          where: { childId },
          data: {
            amountCents: { increment: amountCents },
            updatedAt: new Date(),
          },
        });

        const transaction = await tx.transaction.create({
          data: {
            childId,
            type: TransactionType.deposit,
            amountCents,
            description: `Deposit by ${req.user?.uid}`,
          },
        });

        const volunteer = await prisma.user.findUnique({
          where: { firebaseUid: req.user?.uid },
        });

        if (!volunteer) {
          return res
            .status(404)
            .json({ error: "Volunteer not found in database" });
        }

        await tx.auditLog.create({
          data: {
            userId: volunteer.id,
            action: "deposit",
            entity: "child",
            entityId: childId,
            details: { amountCents, transactionId: transaction.id },
          },
        });

        return { updatedBalance, transaction };
      });

      return res.json({
        message: "Deposit successful",
        balance: result.updatedBalance,
        transaction: result.transaction,
      });
    } catch (err) {
      console.error("Deposit error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// TODO: GET /api/transactions-all
// -------------------------------------------------------

// -------------------------------------------------------
// POST /api/vendor-return
// TODO: Update table schema so that vendors are not a user type but their own thing like children
// Situation 4: Vendor Returns
// -------------------------------------------------------
app.post(
  "/api/vendor-return",
  verifyFirebaseToken,
  requireRole("volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    const { vendorId, tokensSubmitted, marketDate } = req.body;
    if (!vendorId || typeof tokensSubmitted !== "number" || tokensSubmitted < 0)
      return res.status(400).json({
        error: "vendorId and non-negative tokensSubmitted are required",
      });

    try {
      const date = marketDate ? new Date(marketDate) : new Date();

      const record = await prisma.vendorTokenTurnin.create({
        data: {
          vendorId,
          tokensSubmitted,
          marketDate: date,
          verifiedBy: req.user?.uid,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user?.uid,
          action: "vendor_return",
          entity: "vendor_token_turnin",
          entityId: record.id,
          details: { vendorId, tokensSubmitted, marketDate: date },
        },
      });

      return res.json({ message: "Vendor tokens recorded", record });
    } catch (err) {
      console.error("Vendor return error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// TODO: POST /api/vendor-create
// -------------------------------------------------------

// -------------------------------------------------------
// TODO: POST /api/vendor-update
// -------------------------------------------------------

// -------------------------------------------------------
// TODO: GET /api/vendor-search
// -------------------------------------------------------

// server.ts (or api/admin.ts router)
// Assumes: express app, prisma, verifyFirebaseToken, requireRole are already imported/initialized

// Helper to compute age
function computeAge(dob?: Date | null) {
  if (!dob) return null;
  const diff = Date.now() - dob.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

// GET /api/admin/children
// Query params:
//   limit (default 100), offset (default 0)
//   sortBy (name | age | address | balance | parentName | timesCheckedIn | lastCheckin) (default: parentName)
//   order (asc | desc) (default asc)
//   search (exact match across string columns)
app.get(
  "/api/admin/children",

  verifyFirebaseToken,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    console.log("Calling GET API: api/admin/children");
    try {
      const limit = Math.min(Number(req.query.limit ?? 100), 1000); // protect resources
      const offset = Number(req.query.offset ?? 0);
      const sortBy = String(req.query.sortBy ?? "parentName");
      const order =
        String(req.query.order ?? "asc") === "desc" ? "desc" : "asc";
      const search = req.query.search ? String(req.query.search) : null;

      // Map UI sort key to Prisma orderBy
      // fallback default ordering: parent.name asc, child.name asc
      const orderBy: Prisma.ChildOrderByWithRelationInput[] = [];
      if (sortBy === "parentName") {
        orderBy.push({ parent: { name: order } });
        orderBy.push({ name: "asc" });
      } else if (sortBy === "name") {
        orderBy.push({ name: order });
      } else if (sortBy === "balance") {
        // balance is relation — order on balance.amountCents
        orderBy.push({ balance: { amountCents: order } });
      } else if (sortBy === "timesCheckedIn") {
        orderBy.push({ timesCheckedIn: order });
      } else if (sortBy === "lastCheckin") {
        orderBy.push({ balance: { lastCheckin: order } });
      } else {
        // default fallback
        orderBy.push({ parent: { name: "asc" } });
        orderBy.push({ name: "asc" });
      }

      // Build where clause for exact-match search
      let where: Prisma.ChildWhereInput | undefined = undefined;
      if (search) {
        const s = search.trim();
        const isNumeric = !isNaN(Number(s));
        where = {
          OR: [
            { name: { contains: s, mode: "insensitive" } },
            { parent: { name: { contains: s, mode: "insensitive" } } },
            { parent: { street: { contains: s, mode: "insensitive" } } },
            { parent: { city: { contains: s, mode: "insensitive" } } },
            { parent: { state: { contains: s, mode: "insensitive" } } },
            { parent: { zipCode: { contains: s, mode: "insensitive" } } },

            ...(isNumeric ? [{ balance: { amountCents: Number(s) } }] : []),
          ],
        };
      }

      const [total, children] = await Promise.all([
        prisma.child.count({ where }),
        prisma.child.findMany({
          where,
          skip: offset,
          take: limit,
          orderBy,
          include: {
            parent: {
              select: {
                id: true,
                name: true,
                street: true,
                city: true,
                state: true,
                zipCode: true,
              },
            },
            balance: true,
          },
        }),
      ]);

      // map results to fields expected by frontend
      const mapped = children.map((c) => {
        const age = c.dateOfBirth ? computeAge(c.dateOfBirth) : null;
        const address = c.parent
          ? `${c.parent.street ?? ""} ${c.parent.city ?? ""} ${
              c.parent.state ?? ""
            } ${c.parent.zipCode ?? ""}`.trim()
          : "";
        return {
          id: c.id,
          name: c.name,
          gender: c.gender,
          age,
          address,
          balanceCents: c.balance?.amountCents ?? 0,
          parentName: c.parent?.name ?? "",
          parentId: c.parentId,
          timesCheckedIn: c.timesCheckedIn,
          lastCheckin: c.balance?.lastCheckin ?? null,
        };
      });

      return res.json({ total, data: mapped });
    } catch (err) {
      console.error("GET /api/admin/children error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /api/admin/children/export?search=...&sortBy=...&order=...
// returns CSV file
app.get(
  "/api/admin/children/export",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    console.log("Calling GET API: api/admin/children/export");
    try {
      const sortBy = String(req.query.sortBy ?? "parentName");
      const order =
        String(req.query.order ?? "asc") === "desc" ? "desc" : "asc";
      const search = req.query.search ? String(req.query.search) : null;

      // For export, we fetch all rows matching search
      // Reuse same where & orderBy logic (copied / refactor as needed)
      let where: Prisma.ChildWhereInput | undefined = undefined;
      if (search) {
        const s = search.trim();
        const isNumeric = !isNaN(Number(s));
        where = {
          OR: [
            { name: { contains: s, mode: "insensitive" } },
            { parent: { name: { contains: s, mode: "insensitive" } } },
            { parent: { street: { contains: s, mode: "insensitive" } } },
            { parent: { city: { contains: s, mode: "insensitive" } } },
            { parent: { state: { contains: s, mode: "insensitive" } } },
            { parent: { zipCode: { contains: s, mode: "insensitive" } } },

            ...(isNumeric ? [{ balance: { amountCents: Number(s) } }] : []),
          ],
        };
      }

      // orderBy same as above (simple default)
      const orderBy: Prisma.ChildOrderByWithRelationInput[] =
        sortBy === "parentName"
          ? [{ parent: { name: order } }, { name: "asc" }]
          : [{ name: order }];

      const children = await prisma.child.findMany({
        where,
        orderBy,
        include: { parent: true, balance: true },
      });

      // Build CSV header and rows (simple escaping)
      const header = [
        "Name",
        "Age",
        "Address",
        "Balance",
        "Parent Name",
        "Times Checked In",
        "Last Checked In",
      ];
      const rows = children.map((c) => {
        const age = c.dateOfBirth ? computeAge(c.dateOfBirth) : "";
        const address = c.parent
          ? `${c.parent.street ?? ""} ${c.parent.city ?? ""} ${
              c.parent.state ?? ""
            } ${c.parent.zipCode ?? ""}`.trim()
          : "";
        const balance = (c.balance?.amountCents ?? 0) / 100;
        const last = c.balance?.lastCheckin
          ? format(new Date(c.balance.lastCheckin), "yyyy-MM-dd HH:mm:ss")
          : "";
        return [
          c.name,
          String(age),
          address,
          String(balance),
          c.parent?.name ?? "",
          String(c.timesCheckedIn ?? 0),
          last,
        ];
      });

      // Build CSV string
      function escapeCell(cell: string) {
        if (cell == null) return "";
        if (cell.includes('"') || cell.includes(",") || cell.includes("\n")) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      }
      const csvLines = [header.map(escapeCell).join(",")].concat(
        rows.map((r) => r.map((c) => escapeCell(String(c))).join(","))
      );
      const csv = csvLines.join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="breada_children_${Date.now()}.csv"`
      );
      return res.send(csv);
    } catch (err) {
      console.error("GET /api/admin/children/export error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /api/admin/parent/:parentId  -> returns parent + children
app.get(
  "/api/admin/parent/:parentId",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req: Request, res: Response) => {
    console.log("Called api/admin/parent/:parentId: \n", req.params.parentId);
    const parentId = req.params.parentId;
    if (!parentId)
      return res.status(400).json({ error: "parentId is required" });

    try {
      const parent = await prisma.user.findUnique({
        where: { id: parentId },
        include: {
          children: {
            include: { balance: true },
            orderBy: { name: "asc" },
          },
        },
      });

      if (!parent) return res.status(404).json({ error: "Parent not found" });
      console.log("Found Parent: ", parent);
      return res.json({ parent });
    } catch (err) {
      console.error("GET /api/admin/parent/:id error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// GET /api/parents
// Returns all parents
// -------------------------------------------------------
app.get(
  "/api/parents",
  verifyFirebaseToken,
  requireRole("volunteer", "admin"),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parents = await prisma.user.findMany({
        where: { role: "parent" },
        include: {
          children: {
            include: { balance: true },
          },
        },
        orderBy: { name: "asc" }, // default sort
      });

      return res.json(parents);
    } catch (err) {
      console.error("Error fetching parents:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/checkins
// Returns all checkins
// -------------------------------------------------------
app.get(
  "/api/admin/checkins",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { from, to } = req.query;

      if (!from || !to) {
        return res.status(400).json({ error: "from and to are required" });
      }

      const fromDate = new Date(from as string);
      const toDate = new Date(to as string);

      const data = await prisma.checkin.findMany({
        where: {
          checkinTime: { gte: fromDate, lte: toDate },
        },
        include: {
          child: {
            include: {
              parent: true,
              balance: true,
            },
          },
        },
        orderBy: { checkinTime: "desc" },
      });

      const mapped = data.map((entry) => {
        const child = entry.child;
        const age = computeAge(child.dateOfBirth);
        const address = [
          entry.child.parent.street,
          entry.child.parent.city,
          entry.child.parent.state,
          entry.child.parent.zipCode,
        ]
          .filter(Boolean)
          .join(", ");
        return {
          id: entry.id,
          checkinTime: entry.checkinTime,
          childName: child.name,
          age,
          address,
          parentName: child.parent?.name ?? "",
          timesCheckedIn: child.timesCheckedIn,
        };
      });

      res.json({ data: mapped });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/checkins/export
// Create a CSV export of checkins
// -------------------------------------------------------
app.get(
  "/api/admin/checkins/export",
  verifyFirebaseToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { from, to } = req.query;

      const data = await prisma.checkin.findMany({
        where: {
          checkinTime: {
            gte: new Date(from as string),
            lte: new Date(to as string),
          },
        },
        include: {
          child: {
            include: { parent: true },
          },
        },
      });

      const rows = data.map((c) => {
        const age = computeAge(c.child.dateOfBirth);
        const address = [
          c.child.parent.street,
          c.child.parent.city,
          c.child.parent.state,
          c.child.parent.zipCode,
        ]
          .filter(Boolean)
          .join(", ");

        return [
          c.checkinTime.toISOString(),
          c.child.name,
          age,
          address ?? "",
          c.child.parent?.name ?? "",
          c.child.timesCheckedIn,
        ];
      });

      const headers = [
        "CheckinTime",
        "Name",
        "Age",
        "Address",
        "ParentName",
        "TimesCheckedIn",
      ];

      const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.send(csv);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/users/staff
// Returns all staff (admins and volunteers)
// -------------------------------------------------------
app.get(
  "/api/users/staff",
  verifyFirebaseToken,
  requireRole("admin", "volunteer"),
  async (req, res) => {
    const users = await prisma.user.findMany({
      where: {
        role: { in: ["admin", "volunteer"] },
      },
      orderBy: { name: "asc" },
    });

    res.json(users);
  }
);

// -------------------------------------------------------
// POST /api/admin/create-qr-codes
// Returns all staff (admins and volunteers)
// -------------------------------------------------------
app.post(
  "/api/admin/create-qr-codes",
  verifyFirebaseToken,
  requireRole("admin", "volunteer"),
  async (req, res) => {
    try {
      const { count } = req.body;

      // Validate input
      if (
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count <= 0 ||
        count > 1000
      ) {
        return res.status(400).json({
          error: "count must be a positive integer (max 1000)",
        });
      }

      // Generate QR code records
      const codes = Array.from({ length: count }).map(() => ({
        code: nanoid(),
      }));

      // Insert in bulk
      await prisma.qrCode.createMany({
        data: codes,
        skipDuplicates: true,
      });

      return res.json({
        message: `${count} QR codes created`,
        count,
      });
    } catch (err) {
      console.error("Create QR codes error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// GET /api/admin/qr-codes
// Returns all staff (admins and volunteers)
// -------------------------------------------------------
app.get(
  "/api/admin/qr-codes/all",
  verifyFirebaseToken,
  requireRole("admin", "volunteer"),
  async (req: Request, res: Response) => {
    try {
      const qrCodes = await prisma.qrCode.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          child: {
            select: {
              id: true,
              name: true,
              parent: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });

      return res.json({
        qrCodes: qrCodes.map((code) => ({
          id: code.id,
          code: code.code,
          printed: code.printed,
          associatedChild: code.child
            ? {
                id: code.child.id,
                name: code.child.name,
              }
            : null,
        })),
      });
    } catch (err) {
      console.error("Failed to fetch QR codes:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// -------------------------------------------------------
// POST /api/admin/qr-codes/print
// Returns all staff (admins and volunteers)
// -------------------------------------------------------
app.post(
  "/api/admin/qr-codes/print",
  verifyFirebaseToken,
  requireRole("admin", "volunteer"),
  async (req, res) => {
    console.log("Printing PDF with: ", req);
    try {
      const { ids } = req.body as { ids: string[] };

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "No QR codes provided" });
      }

      const doc = new PDFDocument({
        size: "LETTER",
        margin: 36,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="qr-codes.pdf"`);
      doc.pipe(res);

      const cardWidth = 3.375 * 72;
      const cardHeight = 2.125 * 72;
      const cols = 2;
      const rows = 4;
      const marginX = 36;
      const marginY = 36;

      for (let i = 0; i < ids.length; i += cols * rows) {
        const frontCodes = ids.slice(i, i + cols * rows);

        // FRONT PAGE
        for (let index = 0; index < frontCodes.length; index++) {
          const code = frontCodes[index];
          const col = index % cols;
          const row = Math.floor(index / cols);
          const x = marginX + col * cardWidth;
          const y = marginY + row * cardHeight;

          const qrDataUrl = await QRCode.toDataURL(code);
          doc.image(qrDataUrl, x, y, {
            width: cardWidth / 2,
            height: cardHeight,
          });
          doc.rect(x, y, cardWidth, cardHeight).stroke();
        }

        // BACK PAGE
        doc.addPage();
        for (let index = 0; index < frontCodes.length; index++) {
          const col = index % cols;
          const row = Math.floor(index / cols);
          const x = marginX + col * cardWidth;
          const y = marginY + row * cardHeight;

          doc
            .moveTo(x, y + cardHeight / 2)
            .lineTo(x + cardWidth, y + cardHeight / 2)
            .stroke();
          doc.rect(x, y, cardWidth, cardHeight).stroke();
        }

        if (i + cols * rows < ids.length) doc.addPage();
      }

      doc.end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to generate PDF" });
    }
  }
);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
