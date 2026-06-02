require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { prisma } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const SHOP = 'demo-shop.myshopify.com';
const frontendDist = path.resolve(__dirname, '../../frontend/dist');

app.use(cors());
app.use(express.json());

async function getOrCreateSettings() {
  return prisma.shopSettings.upsert({
    where: { shop: SHOP },
    update: {},
    create: { shop: SHOP }
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'CrownCustomers' });
});

app.get('/api/dashboard', async (req, res) => {
  const settings = await getOrCreateSettings();
  const customers = await prisma.customerScore.findMany({ orderBy: { rfmScore: 'desc' }, take: 10 });
  const totalCustomers = await prisma.customerScore.count();
  const topCustomers = await prisma.customerScore.count({ where: { isTop: true } });
  const activities = await prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 5 });

  res.json({ settings, stats: { totalCustomers, topCustomers, emailsSent: activities.length }, customers, activities });
});

app.post('/api/sync-demo', async (req, res) => {
  await prisma.customerScore.deleteMany();
  const demo = [
    ['Karine Ruby', 'karine@example.com', 920, 8, 96, true],
    ['Raju Rastogi', 'raju@example.com', 650, 5, 88, true],
    ['Russell Winfield', 'russell@example.com', 480, 4, 74, false],
    ['Ayumu Hirano', 'ayumu@example.com', 310, 2, 61, false],
    ['Guest Customer', 'guest@example.com', 120, 1, 42, false]
  ];

  for (const [name, email, totalSpent, ordersCount, rfmScore, isTop] of demo) {
    await prisma.customerScore.create({ data: { customerId: email, name, email, totalSpent, ordersCount, rfmScore, isTop } });
  }

  await prisma.activityLog.create({ data: { status: 'synced', customer: 'Demo store', message: 'Demo customers imported successfully.' } });
  res.json({ ok: true, imported: demo.length });
});

app.get('/api/settings', async (req, res) => {
  res.json(await getOrCreateSettings());
});

app.post('/api/settings', async (req, res) => {
  const body = req.body || {};
  const updated = await prisma.shopSettings.upsert({
    where: { shop: SHOP },
    update: {
      enabled: Boolean(body.enabled),
      discountValue: Number(body.discountValue || 15),
      discountType: body.discountType || 'percentage',
      couponDays: Number(body.couponDays || 30),
      emailSubject: body.emailSubject || 'You are one of our Crown Customers!',
      introText: body.introText || 'As a thank you for your loyalty, here is a personal reward.',
      cooldownDays: Number(body.cooldownDays || 30)
    },
    create: {
      shop: SHOP,
      enabled: Boolean(body.enabled),
      discountValue: Number(body.discountValue || 15),
      discountType: body.discountType || 'percentage',
      couponDays: Number(body.couponDays || 30),
      emailSubject: body.emailSubject || 'You are one of our Crown Customers!',
      introText: body.introText || 'As a thank you for your loyalty, here is a personal reward.',
      cooldownDays: Number(body.cooldownDays || 30)
    }
  });
  await prisma.activityLog.create({ data: { status: 'settings_saved', customer: 'Merchant', message: 'Settings saved.' } });
  res.json(updated);
});

app.get('/api/activity', async (req, res) => {
  const logs = await prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(logs);
});

app.use(express.static(frontendDist));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CrownCustomers backend running on http://localhost:${PORT}`);
});
