// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import {
  date,
  double,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/mysql-core";
var accountRoles = ["MANAGER", "WORKER"];
var workerStatuses = ["UNAFFILIATED", "PENDING", "ACTIVE", "REJECTED", "INACTIVE"];
var membershipStatuses = ["PENDING", "ACTIVE", "REJECTED", "INACTIVE"];
var jobStatuses = ["RECRUITING", "CLOSED", "CANCELED"];
var assignmentStatuses = ["PENDING", "ASSIGNED", "REJECTED", "CANCELED", "COMPLETED"];
var paymentStatuses = ["PENDING", "PAID", "CANCELED"];
var users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 20 }).unique(),
  passwordHash: varchar("passwordHash", { length: 255 }),
  accountRole: mysqlEnum("accountRole", accountRoles),
  loginMethod: varchar("loginMethod", { length: 64 }).default("manus-oauth"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var agencies = mysqlTable(
  "agencies",
  {
    id: int("id").autoincrement().primaryKey(),
    managerId: int("managerId").notNull().references(() => users.id),
    name: varchar("name", { length: 100 }).notNull(),
    region: varchar("region", { length: 100 }).notNull(),
    address: text("address"),
    phone: varchar("phone", { length: 20 }),
    description: text("description"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt")
  },
  (table) => ({
    managerIndex: index("agencies_manager_idx").on(table.managerId),
    regionIndex: index("agencies_region_idx").on(table.region)
  })
);
var workerProfiles = mysqlTable(
  "worker_profiles",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id),
    agencyId: int("agencyId").references(() => agencies.id),
    birthDate: date("birthDate"),
    certificate: varchar("certificate", { length: 200 }),
    phone: varchar("phone", { length: 20 }),
    bankAccount: varchar("bankAccount", { length: 100 }),
    bankName: varchar("bankName", { length: 50 }),
    status: mysqlEnum("status", workerStatuses).default("UNAFFILIATED").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => ({
    userUnique: uniqueIndex("worker_profiles_user_unique").on(table.userId),
    agencyStatusIndex: index("worker_profiles_agency_status_idx").on(table.agencyId, table.status)
  })
);
var workerAgencyMemberships = mysqlTable(
  "worker_agency_memberships",
  {
    id: int("id").autoincrement().primaryKey(),
    workerId: int("workerId").notNull().references(() => workerProfiles.id),
    agencyId: int("agencyId").notNull().references(() => agencies.id),
    status: mysqlEnum("status", membershipStatuses).default("PENDING").notNull(),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    respondedAt: timestamp("respondedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => ({
    workerAgencyUnique: uniqueIndex("worker_agency_memberships_unique").on(table.workerId, table.agencyId),
    agencyStatusIndex: index("worker_agency_memberships_agency_status_idx").on(table.agencyId, table.status),
    workerStatusIndex: index("worker_agency_memberships_worker_status_idx").on(table.workerId, table.status)
  })
);
var jobs = mysqlTable(
  "jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    agencyId: int("agencyId").notNull().references(() => agencies.id),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    region: varchar("region", { length: 100 }).notNull(),
    address: text("address"),
    siteLatitude: double("siteLatitude"),
    siteLongitude: double("siteLongitude"),
    geofenceRadiusMeters: int("geofenceRadiusMeters").default(150).notNull(),
    siteGeocodedAt: timestamp("siteGeocodedAt"),
    jobDate: date("jobDate").notNull(),
    startTime: varchar("startTime", { length: 10 }),
    endTime: varchar("endTime", { length: 10 }),
    requiredWorkers: int("requiredWorkers").notNull(),
    dailyWage: int("dailyWage").notNull(),
    status: mysqlEnum("status", jobStatuses).default("RECRUITING").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => ({
    agencyStatusDateIndex: index("jobs_agency_status_date_idx").on(table.agencyId, table.status, table.jobDate),
    regionStatusIndex: index("jobs_region_status_idx").on(table.region, table.status)
  })
);
var jobAssignments = mysqlTable(
  "job_assignments",
  {
    id: int("id").autoincrement().primaryKey(),
    jobId: int("jobId").notNull().references(() => jobs.id),
    workerId: int("workerId").notNull().references(() => workerProfiles.id),
    status: mysqlEnum("status", assignmentStatuses).default("PENDING").notNull(),
    requestedAt: timestamp("requestedAt").defaultNow().notNull(),
    respondedAt: timestamp("respondedAt"),
    completedAt: timestamp("completedAt"),
    canceledAt: timestamp("canceledAt")
  },
  (table) => ({
    jobWorkerUnique: uniqueIndex("job_assignments_job_worker_unique").on(table.jobId, table.workerId),
    workerStatusIndex: index("job_assignments_worker_status_idx").on(table.workerId, table.status),
    jobStatusIndex: index("job_assignments_job_status_idx").on(table.jobId, table.status)
  })
);
var attendanceRecords = mysqlTable(
  "attendance_records",
  {
    id: int("id").autoincrement().primaryKey(),
    workerId: int("workerId").notNull().references(() => workerProfiles.id),
    jobId: int("jobId").notNull().references(() => jobs.id),
    workDate: date("workDate").notNull(),
    checkIn: timestamp("checkIn"),
    checkOut: timestamp("checkOut"),
    checkInLatitude: double("checkInLatitude"),
    checkInLongitude: double("checkInLongitude"),
    checkInAccuracyMeters: int("checkInAccuracyMeters"),
    checkInDistanceMeters: int("checkInDistanceMeters"),
    checkOutLatitude: double("checkOutLatitude"),
    checkOutLongitude: double("checkOutLongitude"),
    checkOutAccuracyMeters: int("checkOutAccuracyMeters"),
    checkOutDistanceMeters: int("checkOutDistanceMeters"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => ({
    workerJobDateUnique: uniqueIndex("attendance_worker_job_date_unique").on(table.workerId, table.jobId, table.workDate),
    workerIndex: index("attendance_worker_idx").on(table.workerId, table.workDate)
  })
);
var paymentRecords = mysqlTable(
  "payment_records",
  {
    id: int("id").autoincrement().primaryKey(),
    workerId: int("workerId").notNull().references(() => workerProfiles.id),
    jobId: int("jobId").notNull().references(() => jobs.id),
    agencyId: int("agencyId").notNull().references(() => agencies.id),
    amount: int("amount").notNull(),
    description: text("description"),
    status: mysqlEnum("status", paymentStatuses).default("PENDING").notNull(),
    paidAt: timestamp("paidAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
  },
  (table) => ({
    workerJobUnique: uniqueIndex("payment_worker_job_unique").on(table.workerId, table.jobId),
    workerStatusIndex: index("payment_worker_status_idx").on(table.workerId, table.status),
    agencyStatusIndex: index("payment_agency_status_idx").on(table.agencyId, table.status)
  })
);

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values = {
      openId: user.openId
    };
    const updateSet = {};
    const textFields = ["name", "email", "loginMethod"];
    const assignNullable = (field) => {
      const value = user[field];
      if (value === void 0) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== void 0) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== void 0) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = /* @__PURE__ */ new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = /* @__PURE__ */ new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return void 0;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app) {
  app.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers/buildOnWorks.ts
import { TRPCError as TRPCError3 } from "@trpc/server";
import { and, count, desc, eq as eq2, isNull, sql } from "drizzle-orm";
import { z as z2 } from "zod";

// server/workerDetail.ts
function ageFromBirthDate(birthDate, referenceDate = /* @__PURE__ */ new Date()) {
  if (!birthDate) return null;
  let age = referenceDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const birthdayThisYear = new Date(Date.UTC(referenceDate.getUTCFullYear(), birthDate.getUTCMonth(), birthDate.getUTCDate()));
  if (referenceDate < birthdayThisYear) age -= 1;
  return Math.max(0, age);
}
function maskBankAccount(account) {
  if (!account) return "\uB4F1\uB85D\uB418\uC9C0 \uC54A\uC74C";
  const compact = account.replace(/\s|-/g, "");
  if (compact.length <= 4) return "\u2022\u2022\u2022\u2022";
  return `\u2022\u2022\u2022\u2022 ${compact.slice(-4)}`;
}
function toManagerWorkerDetail(row) {
  return {
    profile: {
      id: row.profile.id,
      birthDate: row.profile.birthDate,
      certificate: row.profile.certificate,
      phone: row.profile.phone,
      bankName: row.profile.bankName,
      bankAccount: maskBankAccount(row.profile.bankAccount),
      status: row.profile.status
    },
    user: {
      id: row.user.id,
      name: row.user.name,
      phone: row.user.phone
    },
    age: ageFromBirthDate(row.profile.birthDate)
  };
}

// server/workHistory.ts
function summarizeWorkHistory(entries, currentAgencyId) {
  const completed = entries.filter((entry) => entry.status === "COMPLETED").sort((a, b) => (b.completedAt ?? b.job.jobDate).getTime() - (a.completedAt ?? a.job.jobDate).getTime());
  const byAgency = /* @__PURE__ */ new Map();
  for (const entry of completed) {
    const current = byAgency.get(entry.agency.id);
    byAgency.set(entry.agency.id, current ? { ...current, completedCount: current.completedCount + 1 } : { agency: entry.agency, completedCount: 1 });
  }
  return {
    totalCompleted: completed.length,
    currentAgencyCompleted: currentAgencyId ? completed.filter((entry) => entry.agency.id === currentAgencyId).length : null,
    agencies: Array.from(byAgency.values()).sort((a, b) => b.completedCount - a.completedCount || a.agency.name.localeCompare(b.agency.name)),
    recentJobs: completed.map((entry) => ({
      assignmentId: entry.assignmentId,
      title: entry.job.title,
      jobDate: entry.job.jobDate,
      completedAt: entry.completedAt,
      agency: entry.agency
    }))
  };
}

// server/_core/map.ts
function getMapsConfig() {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "Google Maps proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey
  };
}
async function makeRequest(endpoint, params = {}, options = {}) {
  const { baseUrl, apiKey } = getMapsConfig();
  const url = new URL(`${baseUrl}/v1/maps/proxy${endpoint}`);
  url.searchParams.append("key", apiKey);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== void 0 && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });
  const response = await fetch(url.toString(), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : void 0
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Google Maps API request failed (${response.status} ${response.statusText}): ${errorText}`
    );
  }
  return await response.json();
}

// server/geofence.ts
var EARTH_RADIUS_METERS = 6371e3;
var radians = (degrees) => degrees * Math.PI / 180;
function haversineDistanceMeters(from, to) {
  const dLat = radians(to.latitude - from.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function verifyWorksiteGeofence(worksite, position) {
  if (worksite.siteLatitude === null || worksite.siteLongitude === null) return { required: false, withinRange: true, distanceMeters: null };
  if (!position) return { required: true, withinRange: false, distanceMeters: null };
  const distanceMeters = haversineDistanceMeters(position, { latitude: worksite.siteLatitude, longitude: worksite.siteLongitude });
  return { required: true, withinRange: distanceMeters <= worksite.geofenceRadiusMeters, distanceMeters };
}

// server/attendanceDate.ts
var koreaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
function koreanWorkDate(now = /* @__PURE__ */ new Date()) {
  const parts = koreaDateFormatter.formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return /* @__PURE__ */ new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00.000Z`);
}

// server/routers/buildOnWorks.ts
var dateInput = z2.string().regex(/^\d{4}-\d{2}-\d{2}$/, "\uB0A0\uC9DC \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
var coordinateInput = {
  latitude: z2.number().finite().min(-90).max(90).optional(),
  longitude: z2.number().finite().min(-180).max(180).optional(),
  accuracyMeters: z2.number().finite().min(0).max(1e4).optional()
};
function positionFromInput(input) {
  if (input.latitude === void 0 && input.longitude === void 0) return null;
  if (input.latitude === void 0 || input.longitude === void 0) throw invalid("\uD604\uC7AC \uC704\uCE58 \uC815\uBCF4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  return { latitude: input.latitude, longitude: input.longitude };
}
function locationVerification(job, input) {
  const verification = verifyWorksiteGeofence(job, positionFromInput(input));
  if (verification.required && verification.distanceMeters === null) throw invalid("\uD604\uC7A5 \uC704\uCE58 \uC778\uC99D\uC744 \uC704\uD574 \uD604\uC7AC \uC704\uCE58 \uAD8C\uD55C\uC744 \uD5C8\uC6A9\uD574 \uC8FC\uC138\uC694.");
  if (verification.required && !verification.withinRange) throw invalid(`\uD604\uC7A5 \uBC18\uACBD ${job.geofenceRadiusMeters}m \uBC16\uC785\uB2C8\uB2E4. \uD604\uC7A5 \uADFC\uCC98\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.`);
  return verification;
}
function forbidden(message = "\uC774 \uC791\uC5C5\uC744 \uC218\uD589\uD560 \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.") {
  return new TRPCError3({ code: "FORBIDDEN", message });
}
function invalid(message) {
  return new TRPCError3({ code: "BAD_REQUEST", message });
}
function missing(message) {
  return new TRPCError3({ code: "NOT_FOUND", message });
}
async function getAccount(userId) {
  const db = await getDb();
  if (!db) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR", message: "\uB370\uC774\uD130\uBCA0\uC774\uC2A4 \uC5F0\uACB0\uC744 \uC900\uBE44\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
  const [account] = await db.select().from(users).where(eq2(users.id, userId)).limit(1);
  if (!account) throw missing("\uC0AC\uC6A9\uC790 \uACC4\uC815\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  if (account.loginMethod !== "phone-password" || !account.passwordHash) throw forbidden("\uC804\uD654\uBC88\uD638\uC640 \uBE44\uBC00\uBC88\uD638\uB85C \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694.");
  return { db, account };
}
async function managerContext(userId) {
  const { db, account } = await getAccount(userId);
  if (account.accountRole !== "MANAGER") throw forbidden("\uC778\uB825\uC18C\uC7A5 \uACC4\uC815\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  const [agency] = await db.select().from(agencies).where(and(eq2(agencies.managerId, userId), isNull(agencies.deletedAt))).limit(1);
  return { db, account, agency: agency ?? null };
}
async function workerContext(userId) {
  const { db, account } = await getAccount(userId);
  if (account.accountRole !== "WORKER") throw forbidden("\uC778\uBD80 \uACC4\uC815\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  const [profile] = await db.select().from(workerProfiles).where(eq2(workerProfiles.userId, userId)).limit(1);
  if (!profile) throw missing("\uC778\uBD80 \uD504\uB85C\uD544\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  return { db, account, profile };
}
function numberFrom(value) {
  return Number(value ?? 0);
}
async function assignmentCapacity(db, jobId) {
  const [row] = await db.select({ value: count() }).from(jobAssignments).where(and(eq2(jobAssignments.jobId, jobId), eq2(jobAssignments.status, "ASSIGNED")));
  return numberFrom(row?.value);
}
async function completedWorkHistory(db, workerId) {
  const rows = await db.select({ assignment: jobAssignments, job: jobs, agency: agencies }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).innerJoin(agencies, eq2(jobs.agencyId, agencies.id)).where(and(eq2(jobAssignments.workerId, workerId), eq2(jobAssignments.status, "COMPLETED")));
  return summarizeWorkHistory(rows.map((row) => ({
    assignmentId: row.assignment.id,
    status: row.assignment.status,
    completedAt: row.assignment.completedAt,
    job: { id: row.job.id, title: row.job.title, jobDate: row.job.jobDate, agencyId: row.job.agencyId },
    agency: { id: row.agency.id, name: row.agency.name, region: row.agency.region }
  })));
}
var buildOnWorksRouter = router({
  account: router({
    viewer: protectedProcedure.query(async ({ ctx }) => {
      const { db, account } = await getAccount(ctx.user.id);
      const [profile] = await db.select().from(workerProfiles).where(eq2(workerProfiles.userId, ctx.user.id)).limit(1);
      const [agency] = await db.select().from(agencies).where(and(eq2(agencies.managerId, ctx.user.id), isNull(agencies.deletedAt))).limit(1);
      const memberships = profile ? await db.select({ membership: workerAgencyMemberships, agency: agencies }).from(workerAgencyMemberships).innerJoin(agencies, eq2(workerAgencyMemberships.agencyId, agencies.id)).where(eq2(workerAgencyMemberships.workerId, profile.id)).orderBy(desc(workerAgencyMemberships.updatedAt)) : [];
      return {
        account: {
          id: account.id,
          name: account.name,
          phone: account.phone,
          accountRole: account.accountRole,
          loginMethod: account.loginMethod
        },
        profile: profile ?? null,
        managedAgency: agency ?? null,
        memberships
      };
    }),
    setup: protectedProcedure.input(z2.object({
      accountRole: z2.enum(["MANAGER", "WORKER"]),
      name: z2.string().trim().min(2).max(100),
      phone: z2.string().trim().min(8).max(20),
      birthDate: dateInput.optional(),
      certificate: z2.string().trim().max(200).optional(),
      bankName: z2.string().trim().max(50).optional(),
      bankAccount: z2.string().trim().max(100).optional()
    })).mutation(async ({ ctx, input }) => {
      const { db } = await getAccount(ctx.user.id);
      await db.update(users).set({ name: input.name, phone: input.phone, accountRole: input.accountRole }).where(eq2(users.id, ctx.user.id));
      if (input.accountRole === "WORKER") {
        const { birthDate, accountRole: _accountRole, name: _name, ...profileInput } = input;
        const normalizedBirthDate = birthDate ? /* @__PURE__ */ new Date(`${birthDate}T00:00:00.000Z`) : void 0;
        await db.insert(workerProfiles).values({
          userId: ctx.user.id,
          birthDate: normalizedBirthDate,
          certificate: profileInput.certificate,
          phone: profileInput.phone,
          bankName: profileInput.bankName,
          bankAccount: profileInput.bankAccount,
          status: "UNAFFILIATED"
        }).onDuplicateKeyUpdate({
          set: {
            birthDate: normalizedBirthDate,
            certificate: profileInput.certificate,
            phone: profileInput.phone,
            bankName: profileInput.bankName,
            bankAccount: profileInput.bankAccount
          }
        });
      }
      return { success: true };
    })
  }),
  dashboard: router({
    summary: protectedProcedure.query(async ({ ctx }) => {
      const { db, account } = await getAccount(ctx.user.id);
      if (!account.accountRole) return { role: null, needsOnboarding: true };
      if (account.accountRole === "MANAGER") {
        const [, , agency] = [null, null, (await managerContext(ctx.user.id)).agency];
        if (!agency) return { role: "MANAGER", needsAgency: true, agency: null, metrics: null };
        const [activeWorkers] = await db.select({ value: count() }).from(workerAgencyMemberships).where(and(eq2(workerAgencyMemberships.agencyId, agency.id), eq2(workerAgencyMemberships.status, "ACTIVE")));
        const [pendingMembers] = await db.select({ value: count() }).from(workerAgencyMemberships).where(and(eq2(workerAgencyMemberships.agencyId, agency.id), eq2(workerAgencyMemberships.status, "PENDING")));
        const [activeJobs] = await db.select({ value: count() }).from(jobs).where(and(eq2(jobs.agencyId, agency.id), eq2(jobs.status, "RECRUITING")));
        const [paidThisMonth] = await db.select({ value: sql`coalesce(sum(${paymentRecords.amount}), 0)` }).from(paymentRecords).where(and(eq2(paymentRecords.agencyId, agency.id), eq2(paymentRecords.status, "PAID")));
        return {
          role: "MANAGER",
          needsAgency: false,
          agency,
          metrics: { activeWorkers: numberFrom(activeWorkers?.value), pendingMembers: numberFrom(pendingMembers?.value), activeJobs: numberFrom(activeJobs?.value), paidTotal: numberFrom(paidThisMonth?.value) }
        };
      }
      const { profile } = await workerContext(ctx.user.id);
      const [pendingAssignments] = await db.select({ value: count() }).from(jobAssignments).where(and(eq2(jobAssignments.workerId, profile.id), eq2(jobAssignments.status, "PENDING")));
      const [activeAssignments] = await db.select({ value: count() }).from(jobAssignments).where(and(eq2(jobAssignments.workerId, profile.id), eq2(jobAssignments.status, "ASSIGNED")));
      const [totalWages] = await db.select({ value: sql`coalesce(sum(${paymentRecords.amount}), 0)` }).from(paymentRecords).where(and(eq2(paymentRecords.workerId, profile.id), sql`${paymentRecords.status} in ('PENDING', 'PAID')`));
      const memberships = await db.select({ membership: workerAgencyMemberships, agency: agencies }).from(workerAgencyMemberships).innerJoin(agencies, eq2(workerAgencyMemberships.agencyId, agencies.id)).where(eq2(workerAgencyMemberships.workerId, profile.id)).orderBy(desc(workerAgencyMemberships.updatedAt));
      return {
        role: "WORKER",
        needsAgency: memberships.filter((row) => row.membership.status === "ACTIVE").length === 0,
        profile,
        memberships,
        metrics: { pendingAssignments: numberFrom(pendingAssignments?.value), activeAssignments: numberFrom(activeAssignments?.value), totalWages: numberFrom(totalWages?.value), activeMemberships: memberships.filter((row) => row.membership.status === "ACTIVE").length }
      };
    })
  }),
  agency: router({
    list: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError3({ code: "INTERNAL_SERVER_ERROR" });
      return db.select().from(agencies).where(isNull(agencies.deletedAt)).orderBy(agencies.region, agencies.name);
    }),
    create: protectedProcedure.input(z2.object({ name: z2.string().trim().min(2).max(100), region: z2.string().trim().min(2).max(100), address: z2.string().trim().max(500).optional(), phone: z2.string().trim().max(20).optional(), description: z2.string().trim().max(1e3).optional() })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (agency) throw invalid("\uC774\uBBF8 \uB4F1\uB85D\uB41C \uC778\uB825\uC18C\uAC00 \uC788\uC2B5\uB2C8\uB2E4.");
      await db.insert(agencies).values({ managerId: ctx.user.id, ...input });
      return { success: true };
    }),
    update: protectedProcedure.input(z2.object({ name: z2.string().trim().min(2).max(100), region: z2.string().trim().min(2).max(100), address: z2.string().trim().max(500).nullable(), phone: z2.string().trim().max(20).nullable(), description: z2.string().trim().max(1e3).nullable() })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uBA3C\uC800 \uC778\uB825\uC18C\uB97C \uB4F1\uB85D\uD574 \uC8FC\uC138\uC694.");
      await db.update(agencies).set(input).where(eq2(agencies.id, agency.id));
      return { success: true };
    }),
    deactivate: protectedProcedure.mutation(async ({ ctx }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uC6B4\uC601 \uC911\uC778 \uC778\uB825\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const [activeWorker] = await db.select({ value: count() }).from(workerAgencyMemberships).where(and(eq2(workerAgencyMemberships.agencyId, agency.id), sql`${workerAgencyMemberships.status} in ('PENDING', 'ACTIVE')`));
      const [activeJob] = await db.select({ value: count() }).from(jobs).where(and(eq2(jobs.agencyId, agency.id), sql`${jobs.status} in ('RECRUITING', 'CLOSED')`));
      if (numberFrom(activeWorker?.value) > 0 || numberFrom(activeJob?.value) > 0) throw invalid("\uC18C\uC18D \uC778\uBD80\uC640 \uC9C4\uD589\xB7\uB9C8\uAC10 \uC77C\uAC10\uC774 \uC5C6\uB294 \uACBD\uC6B0\uC5D0\uB9CC \uC778\uB825\uC18C \uC6B4\uC601\uC744 \uC911\uC9C0\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      await db.update(agencies).set({ deletedAt: /* @__PURE__ */ new Date() }).where(eq2(agencies.id, agency.id));
      return { success: true };
    }),
    requestMembership: protectedProcedure.input(z2.object({ agencyId: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      const [agency] = await db.select().from(agencies).where(and(eq2(agencies.id, input.agencyId), isNull(agencies.deletedAt))).limit(1);
      if (!agency) throw missing("\uC120\uD0DD\uD55C \uC778\uB825\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const [existing] = await db.select().from(workerAgencyMemberships).where(and(eq2(workerAgencyMemberships.workerId, profile.id), eq2(workerAgencyMemberships.agencyId, input.agencyId))).limit(1);
      if (existing?.status === "ACTIVE") throw invalid("\uC774\uBBF8 \uAC00\uC785 \uC2B9\uC778\uB41C \uC778\uB825\uC18C\uC785\uB2C8\uB2E4.");
      if (existing?.status === "PENDING") throw invalid("\uD574\uB2F9 \uC778\uB825\uC18C\uC758 \uAC00\uC785 \uC2B9\uC778\uC744 \uAE30\uB2E4\uB9AC\uACE0 \uC788\uC2B5\uB2C8\uB2E4.");
      if (existing) {
        await db.update(workerAgencyMemberships).set({ status: "PENDING", requestedAt: /* @__PURE__ */ new Date(), respondedAt: null }).where(eq2(workerAgencyMemberships.id, existing.id));
      } else {
        await db.insert(workerAgencyMemberships).values({ workerId: profile.id, agencyId: input.agencyId, status: "PENDING" });
      }
      return { success: true };
    }),
    members: protectedProcedure.query(async ({ ctx }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) return [];
      const rows = await db.select({ membership: workerAgencyMemberships, profile: workerProfiles, user: users }).from(workerAgencyMemberships).innerJoin(workerProfiles, eq2(workerAgencyMemberships.workerId, workerProfiles.id)).innerJoin(users, eq2(workerProfiles.userId, users.id)).where(eq2(workerAgencyMemberships.agencyId, agency.id)).orderBy(desc(workerAgencyMemberships.updatedAt));
      return rows.map((row) => ({ membership: row.membership, ...toManagerWorkerDetail(row) }));
    }),
    decideMembership: protectedProcedure.input(z2.object({ membershipId: z2.number().int().positive(), approved: z2.boolean() })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uBA3C\uC800 \uC778\uB825\uC18C\uB97C \uB4F1\uB85D\uD574 \uC8FC\uC138\uC694.");
      const [membership] = await db.select().from(workerAgencyMemberships).where(and(eq2(workerAgencyMemberships.id, input.membershipId), eq2(workerAgencyMemberships.agencyId, agency.id), eq2(workerAgencyMemberships.status, "PENDING"))).limit(1);
      if (!membership) throw missing("\uC2B9\uC778 \uB300\uAE30 \uC911\uC778 \uC778\uBD80 \uAC00\uC785 \uC694\uCCAD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      await db.update(workerAgencyMemberships).set({ status: input.approved ? "ACTIVE" : "REJECTED", respondedAt: /* @__PURE__ */ new Date() }).where(eq2(workerAgencyMemberships.id, membership.id));
      return { success: true };
    })
  }),
  jobs: router({
    geocodeAddress: protectedProcedure.input(z2.object({ address: z2.string().trim().min(5).max(500) })).mutation(async ({ ctx, input }) => {
      await managerContext(ctx.user.id);
      const response = await makeRequest("/maps/api/geocode/json", { address: input.address, language: "ko", region: "kr" });
      const result = response.results?.[0];
      if (response.status !== "OK" || !result) throw invalid("\uC8FC\uC18C\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uB3C4\uB85C\uBA85 \uB610\uB294 \uC0C1\uC138 \uC8FC\uC18C\uB97C \uD655\uC778\uD574 \uC8FC\uC138\uC694.");
      return { address: result.formatted_address, latitude: result.geometry.location.lat, longitude: result.geometry.location.lng };
    }),
    managerList: protectedProcedure.query(async ({ ctx }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) return [];
      const rows = await db.select().from(jobs).where(eq2(jobs.agencyId, agency.id)).orderBy(desc(jobs.jobDate));
      return Promise.all(rows.map(async (job) => ({ ...job, assignedCount: await assignmentCapacity(db, job.id) })));
    }),
    discover: protectedProcedure.input(z2.object({ region: z2.string().trim().optional(), agencyId: z2.number().int().positive().optional() }).optional()).query(async ({ ctx, input }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      const filters = [eq2(jobs.status, "RECRUITING")];
      if (input?.region) filters.push(eq2(jobs.region, input.region));
      if (input?.agencyId) filters.push(eq2(jobs.agencyId, input.agencyId));
      const rows = await db.select({ job: jobs, agency: agencies }).from(jobs).innerJoin(agencies, eq2(jobs.agencyId, agencies.id)).where(and(...filters)).orderBy(jobs.jobDate);
      const assignments = await db.select().from(jobAssignments).where(eq2(jobAssignments.workerId, profile.id));
      return Promise.all(rows.map(async (row) => {
        return { ...row, assignment: assignments.find((item) => item.jobId === row.job.id) ?? null, canApply: true, assignedCount: await assignmentCapacity(db, row.job.id) };
      }));
    }),
    workerAssignments: protectedProcedure.query(async ({ ctx }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      return db.select({ assignment: jobAssignments, job: jobs, agency: agencies }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).innerJoin(agencies, eq2(jobs.agencyId, agencies.id)).where(eq2(jobAssignments.workerId, profile.id)).orderBy(desc(jobAssignments.requestedAt));
    }),
    create: protectedProcedure.input(z2.object({ title: z2.string().trim().min(2).max(200), region: z2.string().trim().min(2).max(100), address: z2.string().trim().max(500).optional(), siteLatitude: z2.number().finite().min(-90).max(90).optional(), siteLongitude: z2.number().finite().min(-180).max(180).optional(), geofenceRadiusMeters: z2.number().int().min(50).max(1e3).default(150), jobDate: dateInput, startTime: z2.string().trim().max(10).optional(), endTime: z2.string().trim().max(10).optional(), requiredWorkers: z2.number().int().min(1).max(100), dailyWage: z2.number().int().min(0), description: z2.string().trim().max(2e3).optional() }).superRefine((value, context) => {
      if (value.siteLatitude === void 0 !== (value.siteLongitude === void 0)) context.addIssue({ code: "custom", message: "\uD604\uC7A5 \uC704\uB3C4\uC640 \uACBD\uB3C4\uB294 \uD568\uAED8 \uC800\uC7A5\uD574\uC57C \uD569\uB2C8\uB2E4." });
    })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uBA3C\uC800 \uC778\uB825\uC18C\uB97C \uB4F1\uB85D\uD574 \uC8FC\uC138\uC694.");
      const { jobDate, ...jobValues } = input;
      await db.insert(jobs).values({ agencyId: agency.id, ...jobValues, siteGeocodedAt: input.siteLatitude !== void 0 ? /* @__PURE__ */ new Date() : null, jobDate: /* @__PURE__ */ new Date(`${jobDate}T00:00:00.000Z`) });
      return { success: true };
    }),
    update: protectedProcedure.input(z2.object({ id: z2.number().int().positive(), title: z2.string().trim().min(2).max(200), region: z2.string().trim().min(2).max(100), address: z2.string().trim().max(500).nullable(), siteLatitude: z2.number().finite().min(-90).max(90).nullable().optional(), siteLongitude: z2.number().finite().min(-180).max(180).nullable().optional(), geofenceRadiusMeters: z2.number().int().min(50).max(1e3).optional(), jobDate: dateInput, startTime: z2.string().trim().max(10).nullable(), endTime: z2.string().trim().max(10).nullable(), requiredWorkers: z2.number().int().min(1).max(100), dailyWage: z2.number().int().min(0), description: z2.string().trim().max(2e3).nullable() }).superRefine((value, context) => {
      if (value.siteLatitude !== void 0 && value.siteLongitude !== void 0 && value.siteLatitude === null !== (value.siteLongitude === null)) context.addIssue({ code: "custom", message: "\uD604\uC7A5 \uC704\uB3C4\uC640 \uACBD\uB3C4\uB294 \uD568\uAED8 \uC800\uC7A5\uD574\uC57C \uD569\uB2C8\uB2E4." });
    })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uC778\uB825\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const [job] = await db.select().from(jobs).where(and(eq2(jobs.id, input.id), eq2(jobs.agencyId, agency.id))).limit(1);
      if (!job) throw missing("\uC77C\uAC10\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const { id, jobDate, siteLatitude, siteLongitude, geofenceRadiusMeters, ...changes } = input;
      const locationChanges = siteLatitude === void 0 ? {} : { siteLatitude, siteLongitude, ...geofenceRadiusMeters === void 0 ? {} : { geofenceRadiusMeters }, siteGeocodedAt: siteLatitude === null ? null : /* @__PURE__ */ new Date() };
      await db.update(jobs).set({ ...changes, ...locationChanges, jobDate: /* @__PURE__ */ new Date(`${jobDate}T00:00:00.000Z`) }).where(eq2(jobs.id, id));
      return { success: true };
    }),
    cancel: protectedProcedure.input(z2.object({ id: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uC778\uB825\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      await db.update(jobs).set({ status: "CANCELED" }).where(and(eq2(jobs.id, input.id), eq2(jobs.agencyId, agency.id)));
      return { success: true };
    }),
    submitApplication: protectedProcedure.input(z2.object({ jobId: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      const [job] = await db.select().from(jobs).where(and(eq2(jobs.id, input.jobId), eq2(jobs.status, "RECRUITING"))).limit(1);
      if (!job) throw missing("\uBAA8\uC9D1 \uC911\uC778 \uC77C\uAC10\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      if (await assignmentCapacity(db, job.id) >= job.requiredWorkers) throw invalid("\uBAA8\uC9D1 \uC778\uC6D0\uC774 \uBAA8\uB450 \uCC3C\uC2B5\uB2C8\uB2E4.");
      const [existing] = await db.select().from(jobAssignments).where(and(eq2(jobAssignments.jobId, job.id), eq2(jobAssignments.workerId, profile.id))).limit(1);
      if (existing) throw invalid("\uC774\uBBF8 \uC2E0\uCCAD\uD588\uAC70\uB098 \uCC98\uB9AC\uB41C \uC77C\uAC10\uC785\uB2C8\uB2E4.");
      await db.insert(jobAssignments).values({ jobId: job.id, workerId: profile.id, status: "PENDING" });
      return { success: true };
    }),
    cancelApplication: protectedProcedure.input(z2.object({ assignmentId: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      await db.update(jobAssignments).set({ status: "CANCELED", canceledAt: /* @__PURE__ */ new Date() }).where(and(eq2(jobAssignments.id, input.assignmentId), eq2(jobAssignments.workerId, profile.id), eq2(jobAssignments.status, "PENDING")));
      return { success: true };
    }),
    applicants: protectedProcedure.input(z2.object({ jobId: z2.number().int().positive() })).query(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) return [];
      const [job] = await db.select().from(jobs).where(and(eq2(jobs.id, input.jobId), eq2(jobs.agencyId, agency.id))).limit(1);
      if (!job) throw missing("\uC77C\uAC10\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const rows = await db.select({ assignment: jobAssignments, profile: workerProfiles, user: users }).from(jobAssignments).innerJoin(workerProfiles, eq2(jobAssignments.workerId, workerProfiles.id)).innerJoin(users, eq2(workerProfiles.userId, users.id)).where(eq2(jobAssignments.jobId, job.id)).orderBy(desc(jobAssignments.requestedAt));
      return rows.map((row) => ({ assignment: row.assignment, ...toManagerWorkerDetail(row) }));
    }),
    decideApplication: protectedProcedure.input(z2.object({ assignmentId: z2.number().int().positive(), approved: z2.boolean() })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uC778\uB825\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const [row] = await db.select({ assignment: jobAssignments, job: jobs }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).where(eq2(jobAssignments.id, input.assignmentId)).limit(1);
      if (!row || row.job.agencyId !== agency.id || row.assignment.status !== "PENDING") throw missing("\uC2B9\uC778 \uB300\uAE30 \uC911\uC778 \uC2E0\uCCAD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      if (input.approved && await assignmentCapacity(db, row.job.id) >= row.job.requiredWorkers) throw invalid("\uBAA8\uC9D1 \uC778\uC6D0\uC774 \uBAA8\uB450 \uCC3C\uC2B5\uB2C8\uB2E4.");
      await db.update(jobAssignments).set({ status: input.approved ? "ASSIGNED" : "REJECTED", respondedAt: /* @__PURE__ */ new Date() }).where(eq2(jobAssignments.id, row.assignment.id));
      if (input.approved && await assignmentCapacity(db, row.job.id) >= row.job.requiredWorkers) await db.update(jobs).set({ status: "CLOSED" }).where(eq2(jobs.id, row.job.id));
      return { success: true };
    })
  }),
  workHistory: router({
    mine: protectedProcedure.query(async ({ ctx }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      return completedWorkHistory(db, profile.id);
    }),
    managerWorker: protectedProcedure.input(z2.object({ workerId: z2.number().int().positive() })).query(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uBA3C\uC800 \uC778\uB825\uC18C\uB97C \uB4F1\uB85D\uD574 \uC8FC\uC138\uC694.");
      const [membership] = await db.select({ id: workerAgencyMemberships.id }).from(workerAgencyMemberships).where(and(eq2(workerAgencyMemberships.workerId, input.workerId), eq2(workerAgencyMemberships.agencyId, agency.id))).limit(1);
      const [application] = await db.select({ id: jobAssignments.id }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).where(and(eq2(jobAssignments.workerId, input.workerId), eq2(jobs.agencyId, agency.id))).limit(1);
      if (!membership && !application) throw forbidden("\uC2E0\uCCAD \uB610\uB294 \uAC00\uC785 \uC694\uCCAD \uAD00\uACC4\uAC00 \uC788\uB294 \uC778\uBD80\uC758 \uADFC\uBB34 \uC774\uB825\uB9CC \uC870\uD68C\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      const history = await completedWorkHistory(db, input.workerId);
      return { ...history, currentAgencyCompleted: history.recentJobs.filter((job) => job.agency.id === agency.id).length };
    })
  }),
  attendance: router({
    current: protectedProcedure.query(async ({ ctx }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      return db.select({ assignment: jobAssignments, job: jobs, attendance: attendanceRecords }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).leftJoin(attendanceRecords, and(eq2(attendanceRecords.jobId, jobs.id), eq2(attendanceRecords.workerId, profile.id))).where(and(eq2(jobAssignments.workerId, profile.id), eq2(jobAssignments.status, "ASSIGNED"))).orderBy(jobs.jobDate);
    }),
    history: protectedProcedure.query(async ({ ctx }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      return db.select({ attendance: attendanceRecords, job: jobs }).from(attendanceRecords).innerJoin(jobs, eq2(attendanceRecords.jobId, jobs.id)).where(eq2(attendanceRecords.workerId, profile.id)).orderBy(desc(attendanceRecords.workDate));
    }),
    checkIn: protectedProcedure.input(z2.object({ jobId: z2.number().int().positive(), ...coordinateInput }).superRefine((value, context) => {
      if (value.latitude === void 0 !== (value.longitude === void 0)) context.addIssue({ code: "custom", message: "\uC704\uB3C4\uC640 \uACBD\uB3C4\uB294 \uD568\uAED8 \uC804\uC1A1\uD574\uC57C \uD569\uB2C8\uB2E4." });
    })).mutation(async ({ ctx, input }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      const [row] = await db.select({ assignment: jobAssignments, job: jobs }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).where(and(eq2(jobAssignments.jobId, input.jobId), eq2(jobAssignments.workerId, profile.id), eq2(jobAssignments.status, "ASSIGNED"))).limit(1);
      if (!row) throw forbidden("\uBC30\uC815\uB41C \uC9C4\uD589 \uC911 \uC77C\uAC10\uB9CC \uCD9C\uADFC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      const verification = locationVerification(row.job, input);
      const workDate = koreanWorkDate();
      const [record] = await db.select().from(attendanceRecords).where(and(eq2(attendanceRecords.workerId, profile.id), eq2(attendanceRecords.jobId, input.jobId), eq2(attendanceRecords.workDate, workDate))).limit(1);
      if (record?.checkIn) throw invalid("\uC774\uBBF8 \uCD9C\uADFC\uC774 \uAE30\uB85D\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.");
      const location = { checkIn: /* @__PURE__ */ new Date(), checkInLatitude: input.latitude, checkInLongitude: input.longitude, checkInAccuracyMeters: input.accuracyMeters === void 0 ? null : Math.round(input.accuracyMeters), checkInDistanceMeters: verification.distanceMeters };
      if (record) await db.update(attendanceRecords).set(location).where(eq2(attendanceRecords.id, record.id));
      else await db.insert(attendanceRecords).values({ workerId: profile.id, jobId: input.jobId, workDate, ...location });
      return { success: true, locationVerified: verification.required, distanceMeters: verification.distanceMeters };
    }),
    checkOut: protectedProcedure.input(z2.object({ jobId: z2.number().int().positive(), ...coordinateInput }).superRefine((value, context) => {
      if (value.latitude === void 0 !== (value.longitude === void 0)) context.addIssue({ code: "custom", message: "\uC704\uB3C4\uC640 \uACBD\uB3C4\uB294 \uD568\uAED8 \uC804\uC1A1\uD574\uC57C \uD569\uB2C8\uB2E4." });
    })).mutation(async ({ ctx, input }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      const [record] = await db.select().from(attendanceRecords).where(and(eq2(attendanceRecords.workerId, profile.id), eq2(attendanceRecords.jobId, input.jobId), sql`${attendanceRecords.checkIn} is not null`, isNull(attendanceRecords.checkOut))).orderBy(desc(attendanceRecords.createdAt)).limit(1);
      if (!record) throw invalid("\uCD9C\uADFC \uAE30\uB85D\uC744 \uBA3C\uC800 \uB0A8\uACA8 \uC8FC\uC138\uC694.");
      const [job] = await db.select().from(jobs).where(eq2(jobs.id, input.jobId)).limit(1);
      if (!job) throw missing("\uC77C\uAC10 \uC815\uBCF4\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const verification = locationVerification(job, input);
      const location = { checkOut: /* @__PURE__ */ new Date(), checkOutLatitude: input.latitude, checkOutLongitude: input.longitude, checkOutAccuracyMeters: input.accuracyMeters === void 0 ? null : Math.round(input.accuracyMeters), checkOutDistanceMeters: verification.distanceMeters };
      await db.transaction(async (tx) => {
        await tx.update(attendanceRecords).set(location).where(eq2(attendanceRecords.id, record.id));
        await tx.update(jobAssignments).set({ status: "COMPLETED", completedAt: /* @__PURE__ */ new Date() }).where(and(eq2(jobAssignments.jobId, input.jobId), eq2(jobAssignments.workerId, profile.id), eq2(jobAssignments.status, "ASSIGNED")));
      });
      return { success: true, locationVerified: verification.required, distanceMeters: verification.distanceMeters };
    })
  }),
  payroll: router({
    managerList: protectedProcedure.query(async ({ ctx }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) return [];
      return db.select({ payment: paymentRecords, job: jobs, profile: workerProfiles, user: users }).from(paymentRecords).innerJoin(jobs, eq2(paymentRecords.jobId, jobs.id)).innerJoin(workerProfiles, eq2(paymentRecords.workerId, workerProfiles.id)).innerJoin(users, eq2(workerProfiles.userId, users.id)).where(eq2(paymentRecords.agencyId, agency.id)).orderBy(desc(paymentRecords.createdAt));
    }),
    workerList: protectedProcedure.query(async ({ ctx }) => {
      const { db, profile } = await workerContext(ctx.user.id);
      return db.select({ payment: paymentRecords, job: jobs }).from(paymentRecords).innerJoin(jobs, eq2(paymentRecords.jobId, jobs.id)).where(eq2(paymentRecords.workerId, profile.id)).orderBy(desc(paymentRecords.createdAt));
    }),
    eligibleAssignments: protectedProcedure.query(async ({ ctx }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) return [];
      return db.select({ assignment: jobAssignments, job: jobs, profile: workerProfiles, user: users }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).innerJoin(workerProfiles, eq2(jobAssignments.workerId, workerProfiles.id)).innerJoin(users, eq2(workerProfiles.userId, users.id)).leftJoin(paymentRecords, and(eq2(paymentRecords.jobId, jobs.id), eq2(paymentRecords.workerId, workerProfiles.id))).where(and(eq2(jobs.agencyId, agency.id), eq2(jobAssignments.status, "COMPLETED"), isNull(paymentRecords.id)));
    }),
    create: protectedProcedure.input(z2.object({ workerId: z2.number().int().positive(), jobId: z2.number().int().positive(), amount: z2.number().int().min(0), description: z2.string().trim().max(1e3).optional() })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uC778\uB825\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const [row] = await db.select({ assignment: jobAssignments, job: jobs }).from(jobAssignments).innerJoin(jobs, eq2(jobAssignments.jobId, jobs.id)).where(and(eq2(jobAssignments.jobId, input.jobId), eq2(jobAssignments.workerId, input.workerId), eq2(jobAssignments.status, "COMPLETED"))).limit(1);
      if (!row || row.job.agencyId !== agency.id) throw invalid("\uC644\uB8CC\uB41C \uC77C\uAC10\uB9CC \uC815\uC0B0\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      const [existing] = await db.select().from(paymentRecords).where(and(eq2(paymentRecords.workerId, input.workerId), eq2(paymentRecords.jobId, input.jobId))).limit(1);
      if (existing) throw invalid("\uD574\uB2F9 \uC77C\uAC10\uC758 \uAE09\uC5EC \uC815\uC0B0\uC774 \uC774\uBBF8 \uC0DD\uC131\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      await db.insert(paymentRecords).values({ workerId: input.workerId, jobId: input.jobId, agencyId: agency.id, amount: input.amount, description: input.description, status: "PENDING" });
      return { success: true };
    }),
    markPaid: protectedProcedure.input(z2.object({ paymentId: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const { db, agency } = await managerContext(ctx.user.id);
      if (!agency) throw missing("\uC778\uB825\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const [payment] = await db.select().from(paymentRecords).where(and(eq2(paymentRecords.id, input.paymentId), eq2(paymentRecords.agencyId, agency.id), eq2(paymentRecords.status, "PENDING"))).limit(1);
      if (!payment) throw missing("\uC9C0\uAE09 \uB300\uAE30 \uC911\uC778 \uAE09\uC5EC \uAE30\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      await db.update(paymentRecords).set({ status: "PAID", paidAt: /* @__PURE__ */ new Date() }).where(eq2(paymentRecords.id, payment.id));
      return { success: true };
    })
  })
});

// server/routers/phoneAuth.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq as eq3 } from "drizzle-orm";
import { z as z3 } from "zod";
import { TRPCError as TRPCError4 } from "@trpc/server";
var passwordInput = z3.string().min(4, "\uBE44\uBC00\uBC88\uD638\uB294 4\uC790\uB9AC \uC774\uC0C1 \uC785\uB825\uD574 \uC8FC\uC138\uC694.").max(72, "\uBE44\uBC00\uBC88\uD638\uAC00 \uB108\uBB34 \uAE41\uB2C8\uB2E4.");
function normalizePhone(value) {
  const digits = value.replace(/\D/g, "");
  const normalized = digits.startsWith("82") ? `0${digits.slice(2)}` : digits;
  if (!/^01\d{8,9}$/.test(normalized)) throw new TRPCError4({ code: "BAD_REQUEST", message: "\uC62C\uBC14\uB978 \uD734\uB300\uD3F0 \uBC88\uD638\uB97C \uC785\uB825\uD574 \uC8FC\uC138\uC694." });
  return normalized;
}
function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64).toString("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
async function issueSession(res, req, openId, name) {
  const sessionToken = await sdk.createSessionToken(openId, { name });
  res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
}
var phoneAuthRouter = router({
  register: publicProcedure.input(z3.object({
    name: z3.string().trim().min(2, "\uC774\uB984\uC744 2\uC790 \uC774\uC0C1 \uC785\uB825\uD574 \uC8FC\uC138\uC694.").max(100),
    phone: z3.string().min(8),
    password: passwordInput,
    accountRole: z3.enum(["MANAGER", "WORKER"]),
    birthDate: z3.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    certificate: z3.string().trim().max(200).optional(),
    bankName: z3.string().trim().max(50).optional(),
    bankAccount: z3.string().trim().max(100).optional()
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError4({ code: "INTERNAL_SERVER_ERROR", message: "\uB370\uC774\uD130\uBCA0\uC774\uC2A4 \uC5F0\uACB0\uC744 \uC900\uBE44\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
    const phone = normalizePhone(input.phone);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq3(users.phone, phone)).limit(1);
    if (existing) throw new TRPCError4({ code: "CONFLICT", message: "\uC774\uBBF8 \uAC00\uC785\uB41C \uC804\uD654\uBC88\uD638\uC785\uB2C8\uB2E4. \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694." });
    const result = await db.insert(users).values({
      openId: `phone:${phone}`,
      name: input.name,
      phone,
      passwordHash: hashPassword(input.password),
      accountRole: input.accountRole,
      loginMethod: "phone-password",
      lastSignedIn: /* @__PURE__ */ new Date()
    });
    const userId = Number(result[0].insertId);
    if (input.accountRole === "WORKER") {
      await db.insert(workerProfiles).values({
        userId,
        birthDate: input.birthDate ? /* @__PURE__ */ new Date(`${input.birthDate}T00:00:00.000Z`) : void 0,
        certificate: input.certificate,
        phone,
        bankName: input.bankName,
        bankAccount: input.bankAccount,
        status: "UNAFFILIATED"
      });
    }
    await issueSession(ctx.res, ctx.req, `phone:${phone}`, input.name);
    return { success: true, accountRole: input.accountRole };
  }),
  login: publicProcedure.input(z3.object({ phone: z3.string().min(8), password: passwordInput })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError4({ code: "INTERNAL_SERVER_ERROR", message: "\uB370\uC774\uD130\uBCA0\uC774\uC2A4 \uC5F0\uACB0\uC744 \uC900\uBE44\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
    const phone = normalizePhone(input.phone);
    const [account] = await db.select().from(users).where(eq3(users.phone, phone)).limit(1);
    if (!account || !verifyPassword(input.password, account.passwordHash)) throw new TRPCError4({ code: "UNAUTHORIZED", message: "\uC804\uD654\uBC88\uD638 \uB610\uB294 \uBE44\uBC00\uBC88\uD638\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
    await db.update(users).set({ lastSignedIn: /* @__PURE__ */ new Date() }).where(eq3(users.id, account.id));
    await issueSession(ctx.res, ctx.req, account.openId, account.name ?? "\uD604\uC7A5 \uC0AC\uC6A9\uC790");
    return { success: true, accountRole: account.accountRole };
  })
});

// server/routers.ts
var appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => {
      const user = opts.ctx.user;
      if (!user) return null;
      const { passwordHash: _passwordHash, ...safeUser } = user;
      return safeUser;
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true
      };
    })
  }),
  buildOnWorks: buildOnWorksRouter,
  phoneAuth: phoneAuthRouter
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
async function startServer() {
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
startServer().catch(console.error);
