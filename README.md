# CrownCustomers

A simple Shopify-style full-stack app prototype using:

- Frontend: React + Vite + Shopify Polaris
- Backend: Node.js + Express
- Database: Prisma + SQLite by default, easy to switch to PostgreSQL

## VS Code setup

Open two terminals.

### Terminal 1: backend

```bash
cd backend
npm install
npx prisma generate
npx prisma db push
npm run dev
```

Backend runs on: http://localhost:4000

### Terminal 2: frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on: http://localhost:5173

## What this app does

CrownCustomers identifies top customers using simple RFM-style scoring and lets the merchant configure a reward email/coupon setup.

Pages:

- Dashboard
- Activity
- Settings
- Plan

## Database note

This package uses SQLite so it works quickly on your PC without Railway/Postgres.

For Railway:

- Use the repo root service so Railway can build the frontend and start the backend together.
- Use a PostgreSQL `DATABASE_URL` instead of `file:./prisma/dev.db`.
- Run `npx prisma db push` during setup or in a one-off Railway shell after the database URL is in place.

SQLite can appear to work on Railway, but the filesystem is not a durable production database.

The deployed backend serves the built frontend, so the Railway public domain opens the full app UI.
