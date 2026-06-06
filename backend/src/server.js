require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { prisma } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const DEFAULT_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || 'demo-shop.myshopify.com';
const SHOPIFY_ADMIN_API_VERSION = '2024-10';
const REQUIRED_SYNC_SCOPES = 'read_orders';
const REQUIRED_DISCOUNT_SCOPES = 'write_discounts';
const REQUIRED_SHOPIFY_SCOPES = `${REQUIRED_SYNC_SCOPES},${REQUIRED_DISCOUNT_SCOPES}`;
const frontendDist = path.resolve(__dirname, '../../frontend/dist');

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

function getCurrentShop(req) {
  return (
    req.get('x-shopify-shop-domain') ||
    req.query.shop ||
    req.body?.shop ||
    process.env.SHOPIFY_SHOP_DOMAIN ||
    DEFAULT_SHOP
  );
}

function getShopifyAccessToken() {
  return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '';
}

function buildCustomerNameFromOrder(order, email) {
  const customerFullName = [
    order?.customer?.first_name || order?.customer?.firstName,
    order?.customer?.last_name || order?.customer?.lastName
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const candidateNames = [
    customerFullName,
    order?.customer?.default_address?.name,
    order?.billingAddress?.name,
    order?.shippingAddress?.name,
    order?.billing_address?.name,
    order?.shipping_address?.name
  ].filter(Boolean);
  if (candidateNames.length) return candidateNames[0];
  return `Customer from order #${order?.order_number || order?.orderNumber || order?.name || order?.id || 'unknown'}`;
}

function buildFallbackEmail(order) {
  const rawId = String(order?.id || 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'unknown';
  return `customer-${rawId}@example.local`;
}

function getOrderCustomerEmail(order) {
  return String(
    order?.customer?.email ||
      order?.email ||
      order?.contact_email ||
      ''
  )
    .trim()
    .toLowerCase();
}

function getOrderShopifyCustomerId(order) {
  const rawId =
    order?.customer?.admin_graphql_api_id ||
    order?.customer?.adminGraphqlApiId ||
    order?.customer?.id;

  if (!rawId) return null;
  const value = String(rawId);
  return value.startsWith('gid://') ? value : `gid://shopify/Customer/${value}`;
}

function toCurrencyNumber(amount) {
  const parsed = Number(amount || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysSince(dateValue) {
  const now = Date.now();
  const then = new Date(dateValue).getTime();
  const diff = Math.max(0, now - then);
  return diff / (1000 * 60 * 60 * 24);
}

function scoreDescending(values, currentValue) {
  if (values.length <= 1) return 5;
  const sorted = [...values].sort((a, b) => b - a);
  const index = sorted.findIndex((value) => value === currentValue);
  const bucket = Math.floor((index / sorted.length) * 5);
  return Math.max(1, 5 - bucket);
}

function scoreAscending(values, currentValue) {
  if (values.length <= 1) return 5;
  const sorted = [...values].sort((a, b) => a - b);
  const index = sorted.findIndex((value) => value === currentValue);
  const bucket = Math.floor((index / sorted.length) * 5);
  return Math.max(1, 5 - bucket);
}

function buildSegment({ isTop, rfmScore, recencyScore, frequencyScore, monetaryScore }) {
  if (isTop) return 'Crown Customer';
  if (rfmScore >= 10 || (frequencyScore >= 4 && monetaryScore >= 4)) return 'Gold Customer';
  if (recencyScore <= 2 && (frequencyScore <= 2 || monetaryScore <= 2)) return 'At Risk';
  return 'Regular Customer';
}

function buildSimpleSegment({ isTop, score }) {
  if (isTop) return 'Crown Customer';
  if (score >= 10) return 'Gold Customer';
  if (score <= 5) return 'At Risk';
  return 'Regular Customer';
}

function getMissingScopeMessage() {
  return 'Missing Shopify order permissions. Please reinstall the app with updated scopes.';
}

function getMissingDiscountScopeMessage() {
  return 'Missing write_discounts permission. Please reinstall the app.';
}

function getMissingSessionMessage() {
  return 'Missing Shopify session/token.';
}

function normalizeManualDate(dateValue) {
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

const normalizeErrorList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [{ message: value }];
  if (typeof value === 'object') return [value];
  return [{ message: String(value) }];
};

function formatShopifyErrors(value) {
  return normalizeErrorList(value)
    .map((err) => {
      if (!err) return 'Unknown Shopify error';
      if (typeof err === 'string') return err;
      if (err.field && err.message) {
        const fieldPath = Array.isArray(err.field) ? err.field.join('.') : String(err.field);
        return `${fieldPath}: ${err.message}`;
      }
      if (err.message) return err.message;
      try {
        return JSON.stringify(err);
      } catch (error) {
        return String(err);
      }
    })
    .join('; ');
}

function sanitizeCouponName(name) {
  return (name || 'CUSTOMER')
    .split(' ')[0]
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 10) || 'CUSTOMER';
}

function buildRewardCouponCode() {
  const sequence = String(Date.now()).slice(-4);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let randomSuffix = '';
  for (let index = 0; index < 4; index += 1) {
    randomSuffix += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return `CROWN-${sequence}-${randomSuffix}`;
}

function getCouponEndDate(couponDays) {
  const now = new Date();
  const totalDays = Math.max(1, Number(couponDays || 30));
  return new Date(now.getTime() + totalDays * 24 * 60 * 60 * 1000);
}

function buildShopifyGraphQLError(message, fallbackMessage) {
  const normalized = String(message || '').toLowerCase();
  const error = new Error(message || 'Shopify API request failed.');

  if (
    normalized.includes('access denied') ||
    normalized.includes('scope') ||
    normalized.includes('write_discounts')
  ) {
    error.message = fallbackMessage || getMissingDiscountScopeMessage();
    error.statusCode = 403;
    return error;
  }

  if (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid api key') ||
    normalized.includes('invalid access token') ||
    normalized.includes('oauth')
  ) {
    error.message = getMissingSessionMessage();
    error.statusCode = 401;
    return error;
  }

  error.statusCode = 502;
  return error;
}

function serializeErrorMessage(error, fallbackMessage) {
  return error?.message || fallbackMessage || 'Unknown Shopify coupon generation error.';
}

async function postShopifyGraphQL(shop, accessToken, query, variables, missingScopeMessage) {
  if (!accessToken) {
    const error = new Error(getMissingSessionMessage());
    error.statusCode = 401;
    throw error;
  }

  const endpoint = `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  const responseErrors = normalizeErrorList(response.errors);
  const jsonErrors = normalizeErrorList(json?.errors);
  const dataErrors = normalizeErrorList(json?.data?.errors);
  const combinedErrors = [...responseErrors, ...jsonErrors, ...dataErrors];

  console.log('Coupon Shopify raw response:', JSON.stringify(json, null, 2));
  console.log('[coupon_generation] Shopify GraphQL response', {
    shop,
    status: response.status,
    responseErrors,
    jsonErrors,
    dataErrors
  });

  if (!response.ok || combinedErrors.length) {
    const message =
      formatShopifyErrors(combinedErrors) ||
      `Shopify API request failed: ${response.status}`;
    throw buildShopifyGraphQLError(message, missingScopeMessage);
  }

  return {
    data: json.data,
    json,
    status: response.status
  };
}

async function getOrCreateSettings(shop) {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop }
  });
}

async function fetchShopifyOrders(shop, accessToken) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const createdSince = startDate.toISOString();
  const fields = [
    'id',
    'name',
    'order_number',
    'email',
    'contact_email',
    'current_total_price',
    'total_price',
    'created_at',
    'billing_address',
    'shipping_address',
    'customer'
  ].join(',');
  const baseUrl = `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/orders.json`;

  const orders = [];
  let nextUrl = `${baseUrl}?status=any&limit=250&created_at_min=${encodeURIComponent(createdSince)}&fields=${encodeURIComponent(fields)}`;

  while (nextUrl) {
    try {
      console.log('[shopify_sync] Orders API request started', {
        shop,
        nextUrl
      });

      const response = await fetch(nextUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': accessToken
        }
      });

      const payload = await response.json();

      if (!response.ok || !Array.isArray(payload?.orders)) {
        const responseErrors = normalizeErrorList(payload?.errors || payload);
        const errorMessage =
          formatShopifyErrors(responseErrors) ||
          `Shopify API request failed: ${response.status}`;
        const missingScopes =
          errorMessage.toLowerCase().includes('access denied') ||
          errorMessage.toLowerCase().includes('scope');
        const err = new Error(missingScopes ? getMissingScopeMessage() : errorMessage);
        err.statusCode = missingScopes ? 403 : 502;
        console.error('[shopify_sync] ERROR', err);
        throw err;
      }

      const batchOrders = payload.orders;
      console.log('[shopify_sync] orders fetched', batchOrders.length);

      for (const order of batchOrders) {
        orders.push(order);
      }

      const linkHeader = response.headers.get('link') || '';
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
      nextUrl = nextMatch ? nextMatch[1] : null;
    } catch (error) {
      console.error('[shopify_sync] ERROR', error);
      throw error;
    }
  }

  console.log('[shopify_sync] orders fetched', orders.length);
  return orders;
}

async function createShopifyDiscountCode({ shop, token, customer, settings }) {
  const startsAt = new Date();
  const endsAt = getCouponEndDate(settings.couponDays);
  const discountCode = buildRewardCouponCode();
  const isPercentage = settings.discountType === 'percentage';
  const mutation = `
    mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const basicCodeDiscount = {
    title: `CrownCustomers reward for ${customer.name}`,
    code: discountCode,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection: {
      customers: {
        add: [customer.shopifyCustomerId]
      }
    },
    customerGets: {
      items: { all: true },
      value: isPercentage
        ? { percentage: Number(settings.discountValue || 0) / 100 }
        : {
            discountAmount: {
              amount: Number(settings.discountValue || 0),
              appliesOnEachItem: false
            }
          }
    }
  };

  console.log('[coupon_generation] Creating Shopify discount', {
    shop,
    hasToken: Boolean(token),
    customerName: customer.name,
    customerEmail: customer.email,
    customerId: customer.customerId,
    selectedCustomerId: customer.shopifyCustomerId,
    discountType: settings.discountType,
    discountValue: Number(settings.discountValue || 0),
    generatedCode: discountCode
  });
  console.log('[rewards] customerSelection payload', basicCodeDiscount.customerSelection);

  const response = await postShopifyGraphQL(
    shop,
    token,
    mutation,
    { basicCodeDiscount },
    getMissingDiscountScopeMessage()
  );
  const dataErrors = normalizeErrorList(response.data?.errors);
  const result = response.data?.discountCodeBasicCreate;
  const userErrors = normalizeErrorList(result?.userErrors);
  const combinedErrors = [...dataErrors, ...userErrors];

  console.log('[coupon_generation] discountCodeBasicCreate result', {
    shop,
    customerName: customer.name,
    customerEmail: customer.email,
    selectedCustomerId: customer.shopifyCustomerId,
    responseStatus: response.status,
    dataErrors,
    userErrors
  });

  if (combinedErrors.length) {
    const message = formatShopifyErrors(combinedErrors) || 'Shopify did not return a discount code result.';
    throw buildShopifyGraphQLError(message, getMissingDiscountScopeMessage());
  }

  if (!result?.codeDiscountNode?.id) {
    const message = 'Shopify did not return a discount code result.';
    throw buildShopifyGraphQLError(message, getMissingDiscountScopeMessage());
  }

  return {
    discountCode,
    discountType: settings.discountType,
    discountValue: Number(settings.discountValue || 0),
    startsAt,
    endsAt,
    shopifyDiscountId: result.codeDiscountNode.id
  };
}

function isCooldownActive(existingCoupon, cooldownDays) {
  if (!existingCoupon || existingCoupon.status !== 'created') {
    return false;
  }

  const now = Date.now();
  const cooldownWindow = Math.max(0, Number(cooldownDays || 0)) * 24 * 60 * 60 * 1000;
  const createdAt = new Date(existingCoupon.createdAt).getTime();
  const endsAt = new Date(existingCoupon.endsAt).getTime();

  return endsAt > now || createdAt + cooldownWindow > now;
}

async function logCouponActivity(status, customer, message) {
  await prisma.activityLog.create({
    data: {
      status,
      customer,
      message
    }
  });
}

function buildRankingsFromOrders(shop, orders) {
  const grouped = new Map();
  let fallbackCustomersCreated = 0;

  for (const order of orders) {
    console.log('[sync] order name', order?.name || order?.order_number || order?.id || 'unknown');
    console.log('[sync] raw order customer', order?.customer || null);
    const shopifyCustomerId = getOrderShopifyCustomerId(order);
    const realEmail = getOrderCustomerEmail(order);
    const fallbackEmail = buildFallbackEmail(order);
    const email = realEmail || fallbackEmail;
    const fallbackUsed = !realEmail;
    if (!shopifyCustomerId && !realEmail) {
      fallbackCustomersCreated += 1;
    }

    const customerId = shopifyCustomerId || email;
    let key = customerId;
    let existing = grouped.get(key);

    if (!existing && shopifyCustomerId && realEmail && grouped.has(realEmail)) {
      existing = grouped.get(realEmail);
      grouped.delete(realEmail);
      key = shopifyCustomerId;
    }

    if (!existing && shopifyCustomerId && grouped.has(shopifyCustomerId)) {
      existing = grouped.get(shopifyCustomerId);
      key = shopifyCustomerId;
    }

    existing = existing || {
      shop,
      customerId,
      shopifyCustomerId,
      name: buildCustomerNameFromOrder(order, email),
      email,
      totalSpent: 0,
      ordersCount: 0,
      lastOrderDate: order.created_at || order.createdAt
    };

    if (!existing.shopifyCustomerId && shopifyCustomerId) {
      existing.shopifyCustomerId = shopifyCustomerId;
      existing.customerId = shopifyCustomerId;
    }

    const chosenName = buildCustomerNameFromOrder(order, email);
    if (realEmail && (!existing.email || existing.email.endsWith('@example.local'))) {
      existing.email = realEmail;
    }
    existing.name = !existing.name || existing.name.startsWith('Customer from order')
      ? chosenName
      : existing.name;

    console.log('[sync] chosen customer name', existing.name);
    console.log('[sync] chosen customer email', email);
    console.log('[sync] shopifyCustomerId', existing.shopifyCustomerId || 'missing');
    console.log('[sync] fallback used', fallbackUsed);

    existing.totalSpent += toCurrencyNumber(order.current_total_price || order.total_price || order.currentTotalPriceSet?.shopMoney?.amount);
    existing.ordersCount += 1;
    if (new Date(order.created_at || order.createdAt) > new Date(existing.lastOrderDate)) {
      existing.lastOrderDate = order.created_at || order.createdAt;
    }

    grouped.set(key, existing);
  }

  const customers = Array.from(grouped.values());
  const recencyValues = customers.map((customer) => daysSince(customer.lastOrderDate));
  const frequencyValues = customers.map((customer) => customer.ordersCount);
  const monetaryValues = customers.map((customer) => customer.totalSpent);

  const enriched = customers.map((customer) => {
    const recencyDays = daysSince(customer.lastOrderDate);
    const recencyScore = scoreAscending(recencyValues, recencyDays);
    const frequencyScore = scoreDescending(frequencyValues, customer.ordersCount);
    const monetaryScore = scoreDescending(monetaryValues, customer.totalSpent);
    const rfmScore = recencyScore + frequencyScore + monetaryScore;

    return {
      ...customer,
      totalSpent: Number(customer.totalSpent.toFixed(2)),
      recencyDays,
      recencyScore,
      frequencyScore,
      monetaryScore,
      rfmScore
    };
  });

  const ranked = enriched.sort((a, b) => {
    if (b.rfmScore !== a.rfmScore) return b.rfmScore - a.rfmScore;
    if (b.totalSpent !== a.totalSpent) return b.totalSpent - a.totalSpent;
    return new Date(b.lastOrderDate) - new Date(a.lastOrderDate);
  });

  const topCount = ranked.length ? Math.max(1, Math.ceil(ranked.length * 0.2)) : 0;

  const rankedCustomers = ranked.map((customer, index) => {
    const isTop = index < topCount;
    return {
      shop: customer.shop,
      customerId: customer.customerId,
      shopifyCustomerId: customer.shopifyCustomerId || null,
      name: customer.name,
      email: customer.email,
      totalSpent: customer.totalSpent,
      ordersCount: customer.ordersCount,
      lastOrderDate: new Date(customer.lastOrderDate),
      rfmScore: customer.rfmScore,
      segment: buildSegment({
        isTop,
        rfmScore: customer.rfmScore,
        recencyScore: customer.recencyScore,
        frequencyScore: customer.frequencyScore,
        monetaryScore: customer.monetaryScore
      }),
      isTop
    };
  });

  return {
    rankedCustomers,
    groupedCustomers: customers.length,
    fallbackCustomersCreated
  };
}

async function persistRankings(shop, rankedCustomers, ordersImported) {
  const customerIds = rankedCustomers.map((customer) => customer.customerId);

  await prisma.$transaction(async (tx) => {
    await tx.customerScore.deleteMany({
      where: {
        shop,
        ...(customerIds.length ? { customerId: { notIn: customerIds } } : {})
      }
    });

    for (const customer of rankedCustomers) {
      await tx.customerScore.upsert({
        where: {
          shop_customerId: {
            shop,
            customerId: customer.customerId
          }
        },
        update: {
          shopifyCustomerId: customer.shopifyCustomerId,
          name: customer.name,
          email: customer.email,
          totalSpent: customer.totalSpent,
          ordersCount: customer.ordersCount,
          lastOrderDate: customer.lastOrderDate,
          rfmScore: customer.rfmScore,
          segment: customer.segment,
          isTop: customer.isTop
        },
        create: customer
      });
    }

    await tx.syncState.upsert({
      where: { shop },
      update: {
        lastSyncAt: new Date(),
        customersImported: rankedCustomers.length,
        ordersImported
      },
      create: {
        shop,
        lastSyncAt: new Date(),
        customersImported: rankedCustomers.length,
        ordersImported
      }
    });

    await tx.activityLog.create({
      data: {
        status: 'shopify_sync',
        customer: shop,
        message: `Imported ${ordersImported} orders across ${rankedCustomers.length} customers.`
      }
    });
  });
}

function buildSimpleRankings(shop, customers) {
  const normalizedCustomers = customers.map((customer, index) => ({
    shop,
    customerId: customer.customerId || `manual:${customer.email.toLowerCase() || index}`,
    name: customer.name?.trim() || 'Guest Customer',
    email: customer.email?.trim().toLowerCase() || `customer-${index + 1}@example.com`,
    totalSpent: Number(toCurrencyNumber(customer.totalSpent).toFixed(2)),
    ordersCount: Math.max(0, Number(customer.ordersCount || 0)),
    lastOrderDate: normalizeManualDate(customer.lastOrderDate)
  }));

  const recencyValues = normalizedCustomers.map((customer) => daysSince(customer.lastOrderDate));
  const frequencyValues = normalizedCustomers.map((customer) => customer.ordersCount);
  const monetaryValues = normalizedCustomers.map((customer) => customer.totalSpent);

  const enriched = normalizedCustomers.map((customer) => {
    const recencyScore = scoreAscending(recencyValues, daysSince(customer.lastOrderDate));
    const frequencyScore = scoreDescending(frequencyValues, customer.ordersCount);
    const monetaryScore = scoreDescending(monetaryValues, customer.totalSpent);
    const simpleScore = recencyScore + frequencyScore + monetaryScore;

    return {
      ...customer,
      recencyScore,
      frequencyScore,
      monetaryScore,
      rfmScore: simpleScore
    };
  });

  const ranked = enriched.sort((a, b) => {
    if (b.rfmScore !== a.rfmScore) return b.rfmScore - a.rfmScore;
    if (b.totalSpent !== a.totalSpent) return b.totalSpent - a.totalSpent;
    return new Date(b.lastOrderDate) - new Date(a.lastOrderDate);
  });

  const topCount = ranked.length ? Math.max(1, Math.ceil(ranked.length * 0.2)) : 0;

  return ranked.map((customer, index) => {
    const isTop = index < topCount;
    return {
      shop,
      customerId: customer.customerId,
      name: customer.name,
      email: customer.email,
      totalSpent: customer.totalSpent,
      ordersCount: customer.ordersCount,
      lastOrderDate: customer.lastOrderDate,
      rfmScore: customer.rfmScore,
      segment: buildSimpleSegment({
        isTop,
        score: customer.rfmScore
      }),
      isTop
    };
  });
}

async function upsertRankedCustomers(shop, rankedCustomers) {
  for (const customer of rankedCustomers) {
    await prisma.customerScore.upsert({
      where: {
        shop_customerId: {
          shop,
          customerId: customer.customerId
        }
      },
      update: {
        name: customer.name,
        email: customer.email,
        totalSpent: customer.totalSpent,
        ordersCount: customer.ordersCount,
        lastOrderDate: customer.lastOrderDate,
        rfmScore: customer.rfmScore,
        segment: customer.segment,
        isTop: customer.isTop
      },
      create: customer
    });
  }
}

async function recomputeManualScores(shop) {
  const existingCustomers = await prisma.customerScore.findMany({
    where: { shop },
    orderBy: { updatedAt: 'desc' }
  });
  const rankedCustomers = buildSimpleRankings(shop, existingCustomers);
  await upsertRankedCustomers(shop, rankedCustomers);
  return rankedCustomers;
}

async function seedPreviewCustomers(shop) {
  const existingCustomers = await prisma.customerScore.findMany({ where: { shop } });
  if (existingCustomers.length) {
    return recomputeManualScores(shop);
  }

  const previewCustomers = [
    {
      customerId: 'preview:sarah-chen',
      name: 'Sarah Chen',
      email: 'sarah.chen@example.com',
      totalSpent: 1240,
      ordersCount: 8,
      lastOrderDate: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    },
    {
      customerId: 'preview:michael-ross',
      name: 'Michael Ross',
      email: 'michael.ross@example.com',
      totalSpent: 890,
      ordersCount: 6,
      lastOrderDate: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
    },
    {
      customerId: 'preview:amelia-jones',
      name: 'Amelia Jones',
      email: 'amelia.jones@example.com',
      totalSpent: 560,
      ordersCount: 4,
      lastOrderDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    },
    {
      customerId: 'preview:noah-patel',
      name: 'Noah Patel',
      email: 'noah.patel@example.com',
      totalSpent: 230,
      ordersCount: 2,
      lastOrderDate: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
    }
  ];

  const rankedCustomers = buildSimpleRankings(shop, previewCustomers);

  await prisma.$transaction(async (tx) => {
    for (const customer of rankedCustomers) {
      await tx.customerScore.upsert({
        where: {
          shop_customerId: {
            shop,
            customerId: customer.customerId
          }
        },
        update: {
          name: customer.name,
          email: customer.email,
          totalSpent: customer.totalSpent,
          ordersCount: customer.ordersCount,
          lastOrderDate: customer.lastOrderDate,
          rfmScore: customer.rfmScore,
          segment: customer.segment,
          isTop: customer.isTop
        },
        create: customer
      });
    }

    await tx.syncState.upsert({
      where: { shop },
      update: {
        lastSyncAt: new Date(),
        customersImported: rankedCustomers.length
      },
      create: {
        shop,
        lastSyncAt: new Date(),
        customersImported: rankedCustomers.length,
        ordersImported: 0
      }
    });

    await tx.activityLog.create({
      data: {
        status: 'preview_sync',
        customer: shop,
        message: `Loaded ${rankedCustomers.length} preview customers for UI testing.`
      }
    });
  });

  return rankedCustomers;
}

async function getDashboardSummary(shop) {
  const [totalCustomers, crownCustomers, recentActivityCount, syncState] = await Promise.all([
    prisma.customerScore.count({ where: { shop } }),
    prisma.customerScore.count({ where: { shop, isTop: true } }),
    prisma.activityLog.count({
      where: {
        customer: shop
      }
    }),
    prisma.syncState.findUnique({ where: { shop } })
  ]);

  return {
    totalCustomers,
    crownCustomers,
    recentActivityCount,
    lastSyncAt: syncState?.lastSyncAt || null,
    customersImported: syncState?.customersImported || 0,
    ordersImported: syncState?.ordersImported || 0
  };
}

async function getRankedCustomers(shop) {
  const customers = await prisma.customerScore.findMany({
    where: { shop },
    orderBy: [
      { rfmScore: 'desc' },
      { totalSpent: 'desc' },
      { lastOrderDate: 'desc' }
    ]
  });

  const createdCoupons = await prisma.rewardCoupon.findMany({
    where: { shop, status: 'created' },
    orderBy: { createdAt: 'desc' }
  });
  const latestCouponByCustomerId = new Map();

  for (const coupon of createdCoupons) {
    if (!latestCouponByCustomerId.has(coupon.customerId)) {
      latestCouponByCustomerId.set(coupon.customerId, coupon);
    }
  }

  return customers.map((customer) => ({
    ...customer,
    latestCoupon: latestCouponByCustomerId.get(customer.customerId)
      ? {
          discountCode: latestCouponByCustomerId.get(customer.customerId).discountCode,
          status: latestCouponByCustomerId.get(customer.customerId).status,
          endsAt: latestCouponByCustomerId.get(customer.customerId).endsAt
        }
      : null
  }));
}

async function getRecentCoupons(shop) {
  const rows = await prisma.rewardCoupon.findMany({
    where: { shop },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      customerId: true,
      customerName: true,
      customerEmail: true,
      discountCode: true,
      discountValue: true,
      discountType: true,
      startsAt: true,
      endsAt: true,
      status: true,
      errorMessage: true
    }
  });

  const latestByCustomerId = new Map();
  for (const row of rows) {
    if (!latestByCustomerId.has(row.customerId)) {
      latestByCustomerId.set(row.customerId, row);
    }
    if (latestByCustomerId.size >= 10) {
      break;
    }
  }

  return Array.from(latestByCustomerId.values());
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'CrownCustomers' });
});

app.get('/api/dashboard/summary', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getDashboardSummary(shop));
});

app.get('/api/customers/ranking', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getRankedCustomers(shop));
});

app.post('/api/customers/manual', async (req, res) => {
  const shop = getCurrentShop(req);
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const totalSpent = Number(body.totalSpent || 0);
  const ordersCount = Number(body.ordersCount || 0);
  const lastOrderDate = normalizeManualDate(body.lastOrderDate);

  if (!name || !email) {
    return res.status(400).json({
      ok: false,
      error: 'Name and email are required.'
    });
  }

  if (!Number.isFinite(totalSpent) || !Number.isFinite(ordersCount)) {
    return res.status(400).json({
      ok: false,
      error: 'Total spent and orders count must be valid numbers.'
    });
  }

  const customerId = `manual:${email}`;

  await prisma.customerScore.upsert({
    where: {
      shop_customerId: {
        shop,
        customerId
      }
    },
    update: {
      name,
      email,
      totalSpent: Number(totalSpent.toFixed(2)),
      ordersCount: Math.max(0, Math.round(ordersCount)),
      lastOrderDate
    },
    create: {
      shop,
      customerId,
      name,
      email,
      totalSpent: Number(totalSpent.toFixed(2)),
      ordersCount: Math.max(0, Math.round(ordersCount)),
      lastOrderDate
    }
  });

  const rankedCustomers = await recomputeManualScores(shop);

  await prisma.syncState.upsert({
    where: { shop },
    update: {
      lastSyncAt: new Date(),
      customersImported: rankedCustomers.length
    },
    create: {
      shop,
      lastSyncAt: new Date(),
      customersImported: rankedCustomers.length,
      ordersImported: 0
    }
  });

  await prisma.activityLog.create({
    data: {
      status: 'manual_customer_added',
      customer: shop,
      message: `Added manual customer ${name}.`
    }
  });

  res.json({
    ok: true,
    message: 'Manual customer added.',
    customerId
  });
});

app.post('/api/rewards/generate', async (req, res) => {
  const shop = getCurrentShop(req);
  const token = getShopifyAccessToken();
  const badRequest = (error, details) => {
    console.error('[rewards] bad_request_reason:', { shop, error, details });
    return res.status(400).json({
      ok: false,
      error,
      details
    });
  };

  console.log('[rewards] starting', {
    shop,
    hasToken: Boolean(token)
  });

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: getMissingSessionMessage(),
      requiredScopes: REQUIRED_DISCOUNT_SCOPES
    });
  }

  const settings = await getOrCreateSettings(shop);
  if (!settings.enabled) {
    return badRequest(
      'App is disabled. Enable app first.',
      'Open Settings and enable CrownCustomers before generating reward coupons.'
    );
  }

  if (
    !settings.discountType ||
    !['percentage', 'fixed'].includes(settings.discountType) ||
    !Number.isFinite(Number(settings.discountValue)) ||
    Number(settings.discountValue) <= 0 ||
    !Number.isFinite(Number(settings.couponDays)) ||
    Number(settings.couponDays) <= 0
  ) {
    return badRequest(
      'Discount settings missing. Save discount first.',
      'Set a valid discount value, discount type, and coupon duration in Settings or the Overview discount panel.'
    );
  }

  const crownCustomers = await prisma.customerScore.findMany({
    where: {
      shop,
      OR: [{ isTop: true }, { segment: 'Crown Customer' }]
    },
    orderBy: [{ rfmScore: 'desc' }, { totalSpent: 'desc' }]
  });

  if (!crownCustomers.length) {
    return badRequest(
      'No crown customers found. Run sync first.',
      'Sync Shopify orders so CrownCustomers can calculate the top 20% before generating rewards.'
    );
  }

  const activeCoupons = await prisma.rewardCoupon.findMany({
    where: {
      shop,
      status: 'created',
      customerId: { in: crownCustomers.map((customer) => customer.customerId) }
    },
    orderBy: { createdAt: 'desc' }
  });
  const latestActiveCouponByCustomerId = new Map();

  for (const coupon of activeCoupons) {
    if (!latestActiveCouponByCustomerId.has(coupon.customerId)) {
      latestActiveCouponByCustomerId.set(coupon.customerId, coupon);
    }
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const coupons = [];

  for (const customer of crownCustomers) {
    const customerLabel = customer.name || customer.email || customer.customerId;
    const couponStartsAt = new Date();
    const couponEndsAt = getCouponEndDate(settings.couponDays);
    const existingCoupon = latestActiveCouponByCustomerId.get(customer.customerId);

    console.log('[rewards] candidate found', {
      shop,
      customerName: customer.name,
      customerEmail: customer.email,
      customerId: customer.customerId,
      shopifyCustomerId: customer.shopifyCustomerId,
      discountType: settings.discountType,
      discountValue: Number(settings.discountValue || 0)
    });
    await logCouponActivity(
      'reward_candidate_found',
      customerLabel,
      `Reward candidate found for ${customerLabel}.`
    );

    if (!customer.shopifyCustomerId) {
      skipped += 1;
      const reason = 'Missing Shopify customer id';
      await logCouponActivity(
        'coupon_skipped',
        customerLabel,
        `Skipped coupon generation for ${customerLabel}. Reason: ${reason}`
      );
      continue;
    }

    if (isCooldownActive(existingCoupon, settings.cooldownDays)) {
      skipped += 1;
      const reason = 'Active coupon already exists and cooldown has not expired.';
      await logCouponActivity(
        'coupon_skipped',
        customerLabel,
        `Skipped coupon generation for ${customerLabel}. Reason: ${reason} Existing code: ${existingCoupon.discountCode || 'unknown'}.`
      );
      continue;
    }

    try {
      console.log('[rewards] selected customer id', customer.shopifyCustomerId);
      console.log('[rewards] creating discount', {
        shop,
        customerEmail: customer.email,
        customerId: customer.customerId,
        selectedCustomerId: customer.shopifyCustomerId
      });
      const createdCoupon = await createShopifyDiscountCode({
        shop,
        token,
        customer,
        settings
      });
      created += 1;
      const rewardCoupon = await prisma.rewardCoupon.create({
        data: {
          shop,
          customerScoreId: customer.id,
          customerId: customer.customerId,
          customerEmail: customer.email,
          customerName: customer.name,
          discountCode: createdCoupon.discountCode,
          discountType: createdCoupon.discountType,
          discountValue: createdCoupon.discountValue,
          startsAt: createdCoupon.startsAt,
          endsAt: createdCoupon.endsAt,
          shopifyDiscountId: createdCoupon.shopifyDiscountId,
          status: 'created'
        }
      });
      console.log('[rewards] discount created', {
        shop,
        customerEmail: customer.email,
        code: createdCoupon.discountCode
      });
      await logCouponActivity(
        'discount_created',
        customerLabel,
        `Coupon ${createdCoupon.discountCode} created for ${customerLabel}.`
      );
      await logCouponActivity(
        'coupon_assigned',
        customerLabel,
        `Coupon ${createdCoupon.discountCode} assigned to ${customerLabel}.`
      );
      await logCouponActivity(
        'email_failed',
        customerLabel,
        `Reward email not sent for ${customerLabel}. Email delivery is not configured yet.`
      );
      coupons.push(rewardCoupon);
    } catch (error) {
      failed += 1;
      const reason = serializeErrorMessage(error, 'Shopify coupon creation failed.');
      console.error('[rewards] discount failed', {
        shop,
        hasToken: Boolean(token),
        customerName: customer.name,
        customerEmail: customer.email,
        customerId: customer.customerId,
        discountType: settings.discountType,
        discountValue: Number(settings.discountValue || 0),
        error: reason
      });
      const rewardCoupon = await prisma.rewardCoupon.create({
        data: {
          shop,
          customerScoreId: customer.id,
          customerId: customer.customerId,
          customerEmail: customer.email,
          customerName: customer.name,
          discountCode: null,
          discountType: settings.discountType,
          discountValue: Number(settings.discountValue || 0),
          startsAt: couponStartsAt,
          endsAt: couponEndsAt,
          status: 'failed',
          errorMessage: reason
        }
      });
      await logCouponActivity(
        'discount_creation_failed',
        customerLabel,
        `Coupon generation failed for ${customerLabel}. Reason: ${reason}`
      );
      coupons.push(rewardCoupon);

      if (error.statusCode === 401 || error.statusCode === 403) {
        return res.status(error.statusCode).json({
          ok: false,
          error: error.message,
          created,
          skipped,
          failed,
          coupons
        });
      }
    }
  }

  console.log('[rewards] completed', {
    shop,
    created,
    skipped,
    failed
  });

  res.json({
    ok: true,
    generated: created,
    created,
    skipped,
    failed,
    coupons
  });
});

app.get('/api/rewards/coupons', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getRecentCoupons(shop));
});

app.get('/api/dashboard', async (req, res) => {
  const shop = getCurrentShop(req);
  const [settings, summary, customers, activities] = await Promise.all([
    getOrCreateSettings(shop),
    getDashboardSummary(shop),
    getRankedCustomers(shop),
    prisma.activityLog.findMany({
      where: { customer: shop },
      orderBy: { createdAt: 'desc' },
      take: 5
    })
  ]);

  res.json({
    settings,
    stats: {
      totalCustomers: summary.totalCustomers,
      topCustomers: summary.crownCustomers,
      emailsSent: summary.recentActivityCount,
      lastSyncAt: summary.lastSyncAt,
      customersImported: summary.customersImported,
      ordersImported: summary.ordersImported
    },
    customers,
    activities
  });
});

app.post('/api/sync/shopify-orders', async (req, res) => {
  const shop = getCurrentShop(req);
  const accessToken = getShopifyAccessToken();

  console.log('[shopify_sync] Sync started', { shop, hasToken: Boolean(accessToken) });

  if (!accessToken) {
    return res.status(401).json({
      ok: false,
      error: getMissingSessionMessage(),
      requiredScopes: REQUIRED_SYNC_SCOPES
    });
  }

  try {
    const orders = await fetchShopifyOrders(shop, accessToken);
    console.log('[shopify_sync] Orders fetched', {
      shop,
      ordersFetched: orders.length
    });
    if (!orders.length) {
      return res.json({
        ok: true,
        shop,
        customersImported: 0,
        ordersImported: 0,
        message: 'No Shopify customers found from orders. Create test orders with customer email and run sync again.'
      });
    }
    const { rankedCustomers, groupedCustomers, fallbackCustomersCreated } = buildRankingsFromOrders(shop, orders);
    console.log('[shopify_sync] Orders grouped', {
      shop,
      customersGrouped: groupedCustomers,
      fallbackCustomersCreated
    });

    if (!rankedCustomers.length) {
      return res.json({
        ok: true,
        shop,
        customersImported: 0,
        ordersImported: orders.length,
        message: 'No Shopify customers found from orders. Create test orders with customer email and run sync again.'
      });
    }

    await persistRankings(shop, rankedCustomers, orders.length);
    console.log('[shopify_sync] Customers saved', {
      shop,
      customersSaved: rankedCustomers.length,
      fallbackCustomersCreated
    });
    console.log('[shopify_sync] fallback customers created', fallbackCustomersCreated);
    console.log('[shopify_sync] Final success count', {
      shop,
      customersImported: rankedCustomers.length,
      ordersImported: orders.length
    });
    console.log('[shopify_sync] sync completed', {
      shop,
      customersImported: rankedCustomers.length,
      ordersImported: orders.length
    });

    res.json({
      ok: true,
      shop,
      customersImported: rankedCustomers.length,
      ordersImported: orders.length,
      message: `Imported ${rankedCustomers.length} customers from ${orders.length} Shopify orders.`
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[shopify_sync] ERROR', error);
    res.status(statusCode).json({
      ok: false,
      error: error.message || 'Unknown sync error.',
      requiredScopes: REQUIRED_SHOPIFY_SCOPES
    });
  }
});

app.get('/api/settings', async (req, res) => {
  const shop = getCurrentShop(req);
  res.json(await getOrCreateSettings(shop));
});

app.post('/api/settings', async (req, res) => {
  const shop = getCurrentShop(req);
  const body = req.body || {};
  const updated = await prisma.shopSettings.upsert({
    where: { shop },
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
      shop,
      enabled: Boolean(body.enabled),
      discountValue: Number(body.discountValue || 15),
      discountType: body.discountType || 'percentage',
      couponDays: Number(body.couponDays || 30),
      emailSubject: body.emailSubject || 'You are one of our Crown Customers!',
      introText: body.introText || 'As a thank you for your loyalty, here is a personal reward.',
      cooldownDays: Number(body.cooldownDays || 30)
    }
  });
  await prisma.activityLog.create({
    data: {
      status: 'settings_saved',
      customer: shop,
      message: 'Settings saved.'
    }
  });
  res.json(updated);
});

app.get('/api/activity', async (req, res) => {
  const shop = getCurrentShop(req);
  const logs = await prisma.activityLog.findMany({
    where: { customer: shop },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json(logs);
});

app.use(express.static(frontendDist));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CrownCustomers backend running on http://localhost:${PORT}`);
});
