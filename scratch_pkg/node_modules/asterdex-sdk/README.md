# AsterDEX TypeScript SDK (Unofficial)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)
[![GitHub](https://img.shields.io/badge/GitHub-methodnumber13%2Fasterdex--sdk-blue)](https://github.com/methodnumber13/asterdex-sdk)

**Unofficial** TypeScript SDK for [AsterDEX](https://www.asterdex.com) cryptocurrency exchange. This library provides a comprehensive, type-safe interface for both Spot and Futures trading, with support for REST API calls and real-time WebSocket streams.

> ⚠️ **Disclaimer**: This is an **unofficial, community-maintained SDK** and is not affiliated with or endorsed by AsterDEX. Use at your own risk. For official support, please contact AsterDEX directly.

## ✨ Features

- 🏗️ **Modern TypeScript** - Full TypeScript support with strict type checking
- 🔐 **Complete Authentication** - Support for all AsterDEX authentication types
- 📊 **Spot Trading** - Full spot trading API implementation (30+ methods)
- ⚡ **Futures Trading** - Complete futures/derivatives trading support (50+ methods)
- 🌊 **WebSocket Streams** - Real-time market data and user account updates
- 🔗 **Web3 Integration** - Native Web3 signature authentication for futures
- 💼 **Advanced Order Types** - Support for LIMIT, MARKET, STOP, TAKE_PROFIT, and TRAILING_STOP orders
- 🎯 **Position Management** - Leverage, margin type, and position margin control
- 📈 **Market Data** - Klines, order books, trades, tickers, and funding rates
- 🔄 **Real-Time Updates** - WebSocket streams for prices, trades, liquidations, and account updates
- 🛡️ **Error Handling** - Comprehensive error types with detailed error information
- 🔧 **Configurable** - Flexible configuration with environment variable support
- 📚 **Well Documented** - Complete API documentation with examples
- 🧪 **Thoroughly Tested** - High test coverage with unit and integration tests

## 📋 SDK Coverage

This SDK provides **complete coverage** of the AsterDEX API:

| Category | Methods | Description |
|----------|---------|-------------|
| **Spot Trading** | 30+ | Market data, order management, account info, withdrawals |
| **Futures Trading** | 50+ | Derivatives trading, position management, leverage control |
| **WebSocket Streams** | 15+ | Real-time price updates, trades, order book, account updates |
| **Authentication** | Multiple | API key, signature-based, Web3 signature for futures |
| **Utility Functions** | 10+ | Configuration, dependency checks, stream name generators |

**Total: 100+ methods** covering all major trading operations on AsterDEX.

## 📖 Table of Contents

- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Complete API Reference](#-complete-api-reference)
  - [Main SDK Methods](#-main-sdk-methods)
  - [Spot Trading API](#-spot-trading-api-clientspot)
    - [Market Data Methods](#market-data-methods)
    - [Trading Methods](#trading-methods)
    - [Account Management Methods](#account-management-methods)
    - [User Data Stream Methods](#user-data-stream-methods)
  - [Futures Trading API](#-futures-trading-api-futures)
    - [Market Data Methods](#market-data-methods-1)
    - [Position & Account Configuration](#position--account-configuration-methods)
    - [Futures Trading Methods](#futures-trading-methods)
    - [Futures Account & Position Methods](#futures-account--position-methods)
    - [Futures User Data Stream](#futures-user-data-stream-methods)
  - [WebSocket Streams API](#-websocket-streams-api)
    - [WebSocket Client Methods](#websocket-client-methods)
    - [StreamUtils - Stream Name Generators](#streamutils---stream-name-generators)
    - [WebSocket Event Handlers](#websocket-event-handlers)
  - [Utility Functions](#-utility-functions)
- [Usage Examples](#-usage-examples)
- [Configuration](#%EF%B8%8F-configuration)
- [Error Handling](#error-handling)
- [Testing](#-testing)
- [Development](#%EF%B8%8F-development)
- [License](#-license)
- [Support](#-support)

## 📦 Installation

```bash
npm install asterdex-sdk
```

```bash
yarn add asterdex-sdk
```

```bash
pnpm add asterdex-sdk
```

## 🚀 Quick Start

### Basic Setup

```typescript
import { AsterDEX } from 'asterdex-sdk';

// Initialize with API credentials
const client = new AsterDEX({
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
  environment: 'mainnet' // or 'testnet'
});

// Or initialize from environment variables
const client = AsterDEX.fromEnv();
```

### Environment Variables

Set these environment variables to use `AsterDEX.fromEnv()`:

```bash
ASTERDEX_API_KEY=your-api-key
ASTERDEX_API_SECRET=your-api-secret
ASTERDEX_ENVIRONMENT=mainnet
ASTERDEX_TIMEOUT=60000
ASTERDEX_RECV_WINDOW=5000

# Optional: Custom endpoints (override defaults for any environment)
ASTERDEX_SPOT_URL=https://custom-api.example.com
ASTERDEX_FUTURES_URL=https://custom-futures.example.com
ASTERDEX_WEBSOCKET_URL=wss://custom-ws.example.com
```

> 📘 **For comprehensive configuration options**, see the [Configuration Guide](./docs/CONFIGURATION.md)

### Simple Example

```typescript
import { AsterDEX } from 'asterdex-sdk';

const client = new AsterDEX({
  apiKey: process.env.ASTERDEX_API_KEY,
  apiSecret: process.env.ASTERDEX_API_SECRET,
});

async function example() {
  try {
    // Test connectivity
    await client.ping();
    console.log('Connected to AsterDEX!');

    // Get account information
    const account = await client.spot.getAccount();
    console.log('Account balances:', account.balances);

    // Get current BTC price
    const price = await client.spot.getPrice('BTCUSDT');
    console.log('Current BTC price:', price);

    // Place a limit order
    const order = await client.spot.newOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: '0.001',
      price: '35000.00'
    });
    console.log('Order placed:', order);

  } catch (error) {
    console.error('Error:', error);
  }
}

example();
```

## 📚 Complete API Reference

This SDK provides comprehensive access to all AsterDEX trading APIs. Below is a complete reference of all implemented methods organized by category.

---

## 🔷 Main SDK Methods

### `AsterDEX` Class

The main entry point for the SDK.

| Method | Description | Returns |
|--------|-------------|---------|
| `new AsterDEX(config)` | Creates a new SDK instance with configuration | `AsterDEX` |
| `AsterDEX.fromEnv()` | Creates SDK instance from environment variables | `AsterDEX` |
| `ping()` | Tests API connectivity | `Promise<{}>` |
| `getServerTime()` | Gets server time | `Promise<{serverTime: number}>` |
| `createWebSocketClient(handlers, path)` | Creates WebSocket client for market data | `AsterWebSocketClient` |
| `createCombinedStream(handlers)` | Creates combined WebSocket stream client | `AsterWebSocketClient` |
| `createUserDataStream(listenKey, handlers)` | Creates user data stream WebSocket | `AsterWebSocketClient` |
| `createFuturesClient(userAddr, signerAddr, privateKey)` | Creates Futures trading client | `FuturesClient` |
| `createFuturesWebSocketClient(handlers, path)` | Creates Futures WebSocket client | `AsterWebSocketClient` |
| `createFuturesUserDataStream(listenKey, handlers)` | Creates Futures user data stream | `AsterWebSocketClient` |
| `updateCredentials(apiKey, apiSecret)` | Updates API credentials | `void` |
| `getConfig()` | Gets current configuration | `Config` |

---

## 📊 Spot Trading API (`client.spot`)

### Market Data Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getExchangeInfo()` | Get exchange trading rules and symbol information | None | `Promise<SpotExchangeInfo>` |
| `getOrderBook(symbol, limit?)` | Get order book depth for a symbol | `symbol: string`<br/>`limit?: number` | `Promise<OrderBook>` |
| `getRecentTrades(symbol, limit?)` | Get recent trades list | `symbol: string`<br/>`limit?: number` | `Promise<Trade[]>` |
| `getHistoricalTrades(symbol, limit?, fromId?)` | Get historical trades | `symbol: string`<br/>`limit?: number`<br/>`fromId?: number` | `Promise<Trade[]>` |
| `getAggregatedTrades(symbol, options?)` | Get compressed, aggregate trades | `symbol: string`<br/>`options?: TradeQueryOptions` | `Promise<AggregatedTrade[]>` |
| `getKlines(symbol, interval, options?)` | Get kline/candlestick data | `symbol: string`<br/>`interval: KlineInterval`<br/>`options?: KlineOptions` | `Promise<Kline[]>` |
| `get24hrTicker(symbol?)` | Get 24hr ticker price change statistics | `symbol?: string` | `Promise<Ticker24hr \| Ticker24hr[]>` |
| `getPrice(symbol?)` | Get latest price for symbol(s) | `symbol?: string` | `Promise<PriceTicker \| PriceTicker[]>` |
| `getBookTicker(symbol?)` | Get best price/qty on order book | `symbol?: string` | `Promise<BookTicker \| BookTicker[]>` |
| `getCommissionRate(symbol)` | Get trading fees for symbol | `symbol: string` | `Promise<CommissionRate>` |

**Supported Kline Intervals:** `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`

### Trading Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `newOrder(params)` | Place a new order | `params: NewOrderParams` | `Promise<OrderAck>` |
| `cancelOrder(symbol, orderId?, origClientOrderId?)` | Cancel an active order | `symbol: string`<br/>`orderId?: number`<br/>`origClientOrderId?: string` | `Promise<OrderAck>` |
| `getOrder(symbol, orderId?, origClientOrderId?)` | Check order status | `symbol: string`<br/>`orderId?: number`<br/>`origClientOrderId?: string` | `Promise<Order>` |
| `getOpenOrders(symbol?)` | Get all open orders | `symbol?: string` | `Promise<Order[]>` |
| `getAllOrders(symbol, options?)` | Get all orders (active, canceled, filled) | `symbol: string`<br/>`options?: OrderQueryOptions` | `Promise<Order[]>` |

**Order Types Supported:**
- `LIMIT` - Limit order (requires: `timeInForce`, `quantity`, `price`)
- `MARKET` - Market order (requires: `quantity` OR `quoteOrderQty`)
- `STOP` - Stop-loss order (requires: `quantity`, `price`, `stopPrice`)
- `TAKE_PROFIT` - Take-profit order (requires: `quantity`, `price`, `stopPrice`)
- `STOP_MARKET` - Stop-loss market order (requires: `quantity`, `stopPrice`)
- `TAKE_PROFIT_MARKET` - Take-profit market order (requires: `quantity`, `stopPrice`)

**Time In Force Options:** `GTC` (Good Till Cancel), `IOC` (Immediate or Cancel), `FOK` (Fill or Kill)

### Account Management Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getAccount()` | Get current account information | None | `Promise<SpotAccount>` |
| `getMyTrades(symbol?, options?)` | Get account trade history | `symbol?: string`<br/>`options?: TradeQueryOptions` | `Promise<UserTrade[]>` |
| `transferAsset(params)` | Transfer between spot/futures accounts | `params: AssetTransferParams` | `Promise<AssetTransferResponse>` |
| `sendToAddress(params)` | Transfer asset to another address | `params: SendToAddressParams` | `Promise<AssetTransferResponse>` |
| `getWithdrawFee(chainId, asset)` | Get estimated withdrawal fee | `chainId: string`<br/>`asset: string` | `Promise<WithdrawFee>` |
| `withdraw(params)` | Submit withdrawal request | `params: WithdrawParams` | `Promise<WithdrawResponse>` |
| `getNonce(address, userOperationType, network?)` | Get nonce for user operation | `address: string`<br/>`userOperationType: string`<br/>`network?: string` | `Promise<number>` |
| `createApiKey(params)` | Create new API key | `params: CreateApiKeyParams` | `Promise<ApiKeyResponse>` |

### User Data Stream Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `startUserDataStream()` | Start new user data stream | None | `Promise<ListenKeyResponse>` |
| `keepAliveUserDataStream(listenKey)` | Keep user data stream alive | `listenKey: string` | `Promise<{}>` |
| `closeUserDataStream(listenKey)` | Close user data stream | `listenKey: string` | `Promise<{}>` |

---

## ⚡ Futures Trading API (`futures`)

To use Futures API, first create a Futures client:

```typescript
const futures = client.createFuturesClient(userAddress, signerAddress, privateKey);
```

### Market Data Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `ping(url?)` | Test Futures API connectivity | `url?: string` | `Promise<{}>` |
| `getServerTime(url?)` | Get Futures server time | `url?: string` | `Promise<{serverTime: number}>` |
| `getExchangeInfo()` | Get futures exchange information | None | `Promise<FuturesExchangeInfo>` |
| `getOrderBook(symbol, limit?)` | Get futures order book | `symbol: string`<br/>`limit?: number` | `Promise<FuturesOrderBook>` |
| `getRecentTrades(symbol, limit?)` | Get recent futures trades | `symbol: string`<br/>`limit?: number` | `Promise<FuturesTrade[]>` |
| `getHistoricalTrades(symbol, limit?, fromId?)` | Get historical futures trades | `symbol: string`<br/>`limit?: number`<br/>`fromId?: number` | `Promise<FuturesTrade[]>` |
| `getAggregatedTrades(symbol, options?)` | Get aggregated futures trades | `symbol: string`<br/>`options?: TradeQueryOptions` | `Promise<FuturesAggTrade[]>` |
| `getKlines(symbol, interval, options?)` | Get futures klines | `symbol: string`<br/>`interval: KlineInterval`<br/>`options?: KlineOptions` | `Promise<Kline[]>` |
| `getIndexPriceKlines(pair, interval, options?)` | Get index price klines | `pair: string`<br/>`interval: KlineInterval`<br/>`options?: KlineOptions` | `Promise<Kline[]>` |
| `getMarkPriceKlines(symbol, interval, options?)` | Get mark price klines | `symbol: string`<br/>`interval: KlineInterval`<br/>`options?: KlineOptions` | `Promise<Kline[]>` |
| `getMarkPrice(symbol?)` | Get mark price and funding rate | `symbol?: string` | `Promise<FuturesMarkPrice \| FuturesMarkPrice[]>` |
| `getFundingRate(symbol?, options?)` | Get funding rate history | `symbol?: string`<br/>`options?: TimeRangeOptions` | `Promise<FuturesFundingRate[]>` |
| `get24hrTicker(symbol?)` | Get 24hr futures ticker | `symbol?: string` | `Promise<Futures24hrTicker \| Futures24hrTicker[]>` |
| `getPrice(symbol?)` | Get latest futures price | `symbol?: string` | `Promise<PriceTicker \| PriceTicker[]>` |
| `getBookTicker(symbol?)` | Get best price/qty on futures book | `symbol?: string` | `Promise<BookTicker \| BookTicker[]>` |

### Position & Account Configuration Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `changePositionMode(dualSidePosition)` | Change position mode (Hedge/One-way) | `dualSidePosition: boolean` | `Promise<ApiSuccessResponse>` |
| `getPositionMode()` | Get current position mode | None | `Promise<FuturesPositionMode>` |
| `changeMultiAssetsMode(multiAssetsMargin)` | Enable/disable multi-assets mode | `multiAssetsMargin: boolean` | `Promise<ApiSuccessResponse>` |
| `getMultiAssetsMode()` | Get current multi-assets mode | None | `Promise<FuturesMultiAssetsMode>` |
| `changeLeverage(params)` | Change initial leverage | `params: FuturesLeverageParams` | `Promise<FuturesLeverageResponse>` |
| `changeMarginType(params)` | Change margin type (ISOLATED/CROSS) | `params: FuturesMarginTypeParams` | `Promise<ApiSuccessResponse>` |
| `modifyPositionMargin(params)` | Modify isolated position margin | `params: FuturesPositionMarginParams` | `Promise<FuturesPositionMarginResponse>` |

### Futures Trading Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `newOrder(params)` | Place new futures order | `params: FuturesNewOrderParams` | `Promise<FuturesOrderResponse>` |
| `newBatchOrders(params)` | Place multiple orders (max 5) | `params: FuturesBatchOrderParams` | `Promise<FuturesOrderResponse[]>` |
| `getOrder(symbol, orderId?, origClientOrderId?)` | Query order status | `symbol: string`<br/>`orderId?: number`<br/>`origClientOrderId?: string` | `Promise<FuturesOrderResponse>` |
| `cancelOrder(symbol, orderId?, origClientOrderId?)` | Cancel active order | `symbol: string`<br/>`orderId?: number`<br/>`origClientOrderId?: string` | `Promise<FuturesOrderResponse>` |
| `cancelAllOpenOrders(symbol)` | Cancel all open orders for symbol | `symbol: string` | `Promise<ApiSuccessResponse>` |
| `cancelBatchOrders(symbol, orderIdList?, origClientOrderIdList?)` | Cancel multiple orders | `symbol: string`<br/>`orderIdList?: number[]`<br/>`origClientOrderIdList?: string[]` | `Promise<FuturesOrderResponse[]>` |
| `countdownCancelAll(params)` | Auto-cancel all orders after countdown | `params: FuturesCountdownCancelParams` | `Promise<FuturesCountdownCancelResponse>` |
| `getCurrentOpenOrder(symbol, orderId?, origClientOrderId?)` | Query current open order | `symbol: string`<br/>`orderId?: number`<br/>`origClientOrderId?: string` | `Promise<FuturesOrderResponse>` |
| `getOpenOrders(symbol?)` | Get all open futures orders | `symbol?: string` | `Promise<FuturesOrderResponse[]>` |
| `getAllOrders(symbol, options?)` | Get all futures orders | `symbol: string`<br/>`options?: OrderQueryOptions` | `Promise<FuturesOrderResponse[]>` |

**Futures Order Types Supported:**
- `LIMIT` - Limit order
- `MARKET` - Market order
- `STOP` / `STOP_MARKET` - Stop-loss orders
- `TAKE_PROFIT` / `TAKE_PROFIT_MARKET` - Take-profit orders
- `TRAILING_STOP_MARKET` - Trailing stop order

### Futures Account & Position Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getBalance()` | Get futures account balance | None | `Promise<FuturesBalance[]>` |
| `getAccount()` | Get futures account information | None | `Promise<FuturesAccount>` |
| `getPositionRisk(symbol?)` | Get position information | `symbol?: string` | `Promise<FuturesPositionRisk[]>` |
| `getUserTrades(symbol, options?)` | Get account trade list | `symbol: string`<br/>`options?: TradeQueryOptions` | `Promise<FuturesUserTrade[]>` |
| `getIncomeHistory(options?)` | Get income history | `options?: IncomeHistoryOptions` | `Promise<FuturesIncome[]>` |
| `getLeverageBracket(symbol?)` | Get leverage brackets | `symbol?: string` | `Promise<FuturesLeverageBracket[]>` |
| `getADLQuantile(symbol?)` | Get ADL quantile estimation | `symbol?: string` | `Promise<FuturesADLQuantile[]>` |
| `getForceOrders(options?)` | Get user's force orders | `options?: ForceOrderOptions` | `Promise<FuturesForceOrder[]>` |
| `getCommissionRate(symbol)` | Get commission rate | `symbol: string` | `Promise<FuturesCommissionRate>` |
| `getPositionMarginHistory(symbol, options?)` | Get position margin history | `symbol: string`<br/>`options?: PositionMarginHistoryOptions` | `Promise<FuturesPositionMarginHistory[]>` |
| `transferAsset(params)` | Transfer between futures/spot | `params: FuturesTransferParams` | `Promise<FuturesTransferResponse>` |

### Futures User Data Stream Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `startUserDataStream()` | Start futures user data stream | None | `Promise<FuturesListenKeyResponse>` |
| `keepAliveUserDataStream(listenKey)` | Keep futures stream alive | `listenKey: string` | `Promise<{}>` |
| `closeUserDataStream(listenKey)` | Close futures stream | `listenKey: string` | `Promise<{}>` |

### Futures Authentication Helper Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `updateWeb3Credentials(userAddr, signerAddr, privateKey)` | Update Web3 credentials | `userAddress: string`<br/>`signerAddress: string`<br/>`privateKey: string` | `void` |
| `hasAuthentication()` | Check if Web3 auth configured | None | `boolean` |
| `getUserAddress()` | Get user address | None | `string \| undefined` |
| `getSignerAddress()` | Get signer address | None | `string \| undefined` |

---

## 🌐 WebSocket Streams API

### WebSocket Client Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `connect()` | Connect to WebSocket server | None | `Promise<void>` |
| `disconnect()` | Disconnect from server | None | `void` |
| `subscribe(streams)` | Subscribe to stream(s) | `streams: string \| string[]` | `Promise<void>` |
| `unsubscribe(streams)` | Unsubscribe from stream(s) | `streams: string \| string[]` | `Promise<void>` |
| `listSubscriptions()` | List current subscriptions | None | `Promise<string[]>` |
| `setProperty(property, value)` | Set WebSocket property | `property: string`<br/>`value: boolean` | `Promise<void>` |
| `getProperty(property)` | Get WebSocket property | `property: string` | `Promise<any>` |
| `getState()` | Get connection state | None | `WebSocketState` |
| `isConnected()` | Check if connected | None | `boolean` |
| `getSubscriptions()` | Get subscription list | None | `string[]` |

### StreamUtils - Stream Name Generators

Static utility methods to generate WebSocket stream names:

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `StreamUtils.aggTrade(symbol)` | Aggregate trade stream | `symbol: string` | `string` |
| `StreamUtils.trade(symbol)` | Trade stream | `symbol: string` | `string` |
| `StreamUtils.kline(symbol, interval)` | Kline/candlestick stream | `symbol: string`<br/>`interval: KlineInterval` | `string` |
| `StreamUtils.miniTicker(symbol)` | Mini ticker stream | `symbol: string` | `string` |
| `StreamUtils.ticker(symbol)` | 24hr ticker stream | `symbol: string` | `string` |
| `StreamUtils.bookTicker(symbol)` | Best bid/ask stream | `symbol: string` | `string` |
| `StreamUtils.depth(symbol, levels?, updateSpeed?)` | Order book depth stream | `symbol: string`<br/>`levels?: number`<br/>`updateSpeed?: '100ms'` | `string` |
| `StreamUtils.allMiniTicker()` | All market mini tickers | None | `string` |
| `StreamUtils.allTicker()` | All market tickers | None | `string` |
| `StreamUtils.allBookTicker()` | All market book tickers | None | `string` |
| `StreamUtils.futuresMarkPrice(symbol)` | Futures mark price stream | `symbol: string` | `string` |
| `StreamUtils.allFuturesMarkPrice()` | All futures mark prices | None | `string` |
| `StreamUtils.futuresLiquidation(symbol)` | Futures liquidation stream | `symbol: string` | `string` |
| `StreamUtils.allFuturesLiquidation()` | All futures liquidations | None | `string` |
| `StreamUtils.futuresCompositeIndex(symbol)` | Futures composite index | `symbol: string` | `string` |

### WebSocket Event Handlers

**Spot Stream Events:**
- `onOpen()` - Connection opened
- `onClose(code, reason)` - Connection closed
- `onError(error)` - Error occurred
- `onTicker(data)` - 24hr ticker update
- `onMiniTicker(data)` - Mini ticker update
- `onTrade(data)` - Trade update
- `onAggTrade(data)` - Aggregate trade update
- `onKline(data)` - Kline/candlestick update
- `onDepthUpdate(data)` - Order book depth update
- `onBookTicker(data)` - Best bid/ask update
- `onAccountUpdate(data)` - Account balance update
- `onExecutionReport(data)` - Order execution update

**Futures Stream Events:**
- All spot events plus:
- `onMarkPrice(data)` - Mark price update
- `onLiquidation(data)` - Liquidation order update
- `onOrderUpdate(data)` - Futures order update
- `onAccountConfigUpdate(data)` - Account config update

---

## 🔧 Utility Functions

### Web3 Dependencies

| Function | Description | Returns |
|----------|-------------|---------|
| `checkWeb3Dependencies()` | Check if Web3 dependencies are installed | `{available: boolean, missing: string[]}` |
| `getWeb3InstallationInstructions()` | Get Web3 installation instructions | `string` |

---

## 📝 Usage Examples

### Example: Complete Spot Trading Flow

```typescript
import { AsterDEX } from 'asterdex-sdk';

const client = new AsterDEX({
  apiKey: process.env.ASTERDEX_API_KEY,
  apiSecret: process.env.ASTERDEX_API_SECRET,
});

async function spotTradingExample() {
  // 1. Test connectivity
  await client.ping();
  console.log('Connected to AsterDEX!');

  // 2. Get account information
  const account = await client.spot.getAccount();
  console.log('Account balances:', account.balances);

  // 3. Get current BTC price
  const price = await client.spot.getPrice('BTCUSDT');
  console.log('Current BTC price:', price);

  // 4. Place a limit order
  const order = await client.spot.newOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: '0.001',
    price: '35000.00'
  });
  console.log('Order placed:', order);

  // 5. Check order status
  const orderStatus = await client.spot.getOrder('BTCUSDT', order.orderId);
  console.log('Order status:', orderStatus);

  // 6. Get all open orders
  const openOrders = await client.spot.getOpenOrders('BTCUSDT');
  console.log('Open orders:', openOrders);
}

spotTradingExample().catch(console.error);

```

### Example: WebSocket Real-Time Data

```typescript
import { AsterDEX, StreamUtils } from 'asterdex-sdk';

const client = new AsterDEX({
  apiKey: process.env.ASTERDEX_API_KEY,
  apiSecret: process.env.ASTERDEX_API_SECRET,
});

async function websocketExample() {
  // Create WebSocket client with event handlers
  const ws = client.createWebSocketClient({
    onTicker: (data) => {
      console.log(`${data.s}: $${data.c} (${data.P}% 24h change)`);
    },
    onTrade: (data) => {
      console.log(`Trade: ${data.s} ${data.p} @ ${data.q}`);
    },
    onDepthUpdate: (data) => {
      console.log(`Depth update for ${data.s}`);
    },
    onError: (error) => {
      console.error('WebSocket error:', error);
    }
  });

  // Connect to WebSocket
  await ws.connect();

  // Subscribe to multiple streams
  await ws.subscribe([
    StreamUtils.ticker('BTCUSDT'),
    StreamUtils.trade('ETHUSDT'),
    StreamUtils.depth('BTCUSDT', 20),
    StreamUtils.kline('BTCUSDT', '1m')
  ]);

  console.log('WebSocket connected and subscribed!');
}

websocketExample().catch(console.error);
```

### Example: User Data Stream (Account Updates)

```typescript
import { AsterDEX } from 'asterdex-sdk';

const client = new AsterDEX({
  apiKey: process.env.ASTERDEX_API_KEY,
  apiSecret: process.env.ASTERDEX_API_SECRET,
});

async function userDataStreamExample() {
  // Start user data stream
  const { listenKey } = await client.spot.startUserDataStream();

  // Create user data WebSocket
  const userWs = client.createUserDataStream(listenKey, {
    onAccountUpdate: (data) => {
      console.log('Account balance update:', data.B);
    },
    onExecutionReport: (data) => {
      console.log(`Order ${data.i} status: ${data.X}`);
      console.log(`Symbol: ${data.s}, Side: ${data.S}, Price: ${data.p}`);
    }
  });

  await userWs.connect();
  console.log('User data stream connected!');

  // Keep alive every 30 minutes
  setInterval(async () => {
    await client.spot.keepAliveUserDataStream(listenKey);
    console.log('User data stream keep-alive sent');
  }, 30 * 60 * 1000);
}

userDataStreamExample().catch(console.error);
```

### Example: Futures Trading

```typescript
import { AsterDEX, checkWeb3Dependencies } from 'asterdex-sdk';

// Check Web3 dependencies
const web3Check = checkWeb3Dependencies();
if (!web3Check.available) {
  console.error('Missing Web3 dependencies:', web3Check.missing);
  process.exit(1);
}

const client = new AsterDEX({ environment: 'testnet' });

// Create Futures client with Web3 credentials
const futures = client.createFuturesClient(
  '0x1E09ae6526A70fa26E25112b858DD6927e37655E', // User address
  '0x001AA685f118954F5984eb4D000f1a184F3f4aED', // Signer address
  '0x4efec379443ff915877459330cf1a39e045bee0061398fe420924b3be2170aa1' // Private key
);

async function futuresTradingExample() {
  // Get account information
  const account = await futures.getAccount();
  console.log('Futures account balance:', account.totalWalletBalance);

  // Get mark price
  const markPrice = await futures.getMarkPrice('BTCUSDT');
  console.log('BTC mark price:', markPrice);

  // Set leverage
  await futures.changeLeverage({
    symbol: 'BTCUSDT',
    leverage: 10
  });
  console.log('Leverage set to 10x');

  // Place a futures order
  const order = await futures.newOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: '0.001',
    price: '50000',
    positionSide: 'LONG'
  });
  console.log('Futures order placed:', order);

  // Get positions
  const positions = await futures.getPositionRisk();
  console.log('Current positions:', positions);
}

futuresTradingExample().catch(console.error);
```

### Example: Futures WebSocket Streams

```typescript
import { AsterDEX, StreamUtils } from 'asterdex-sdk';

const client = new AsterDEX({ environment: 'testnet' });

async function futuresWebSocketExample() {
  // Create Futures WebSocket client
  const futuresWs = client.createFuturesWebSocketClient({
    onMarkPrice: (data) => {
      console.log(`Mark price ${data.s}: $${data.p} (funding: ${data.r})`);
    },
    onLiquidation: (data) => {
      console.log(`Liquidation: ${data.o.s} ${data.o.S} ${data.o.q} @ $${data.o.p}`);
    }
  });

  await futuresWs.connect();

  // Subscribe to futures streams
  await futuresWs.subscribe([
    StreamUtils.futuresMarkPrice('BTCUSDT'),
    StreamUtils.allFuturesLiquidation(),
    StreamUtils.ticker('BTCUSDT')
  ]);

  console.log('Futures WebSocket connected!');
}

futuresWebSocketExample().catch(console.error);
```

### Example: Advanced Order Management

```typescript
import { AsterDEX } from 'asterdex-sdk';

const client = new AsterDEX({
  apiKey: process.env.ASTERDEX_API_KEY,
  apiSecret: process.env.ASTERDEX_API_SECRET,
});

async function advancedOrderExample() {
  // Place multiple order types

  // 1. Limit order
  const limitOrder = await client.spot.newOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: '0.001',
    price: '35000'
  });

  // 2. Stop-loss order
  const stopLoss = await client.spot.newOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    quantity: '0.001',
    stopPrice: '33000'
  });

  // 3. Take-profit order
  const takeProfit = await client.spot.newOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'TAKE_PROFIT_MARKET',
    quantity: '0.001',
    stopPrice: '40000'
  });

  console.log('Orders placed:', { limitOrder, stopLoss, takeProfit });

  // Monitor order status
  const orderStatus = await client.spot.getOrder('BTCUSDT', limitOrder.orderId);
  console.log('Order status:', orderStatus.status);

  // Cancel order if needed
  if (orderStatus.status === 'NEW') {
    await client.spot.cancelOrder('BTCUSDT', limitOrder.orderId);
    console.log('Order cancelled');
  }
}

advancedOrderExample().catch(console.error);
```

### Error Handling

```typescript
import {
  ApiResponseError,
  RateLimitError,
  NetworkError,
  ValidationError
} from 'asterdex-sdk';

try {
  await client.spot.newOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'LIMIT',
    // Missing required parameters
  });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Validation error:', error.message);
  } else if (error instanceof RateLimitError) {
    console.error('Rate limited. Retry after:', error.retryAfter);
  } else if (error instanceof ApiResponseError) {
    console.error('API error:', error.code, error.message);
  } else if (error instanceof NetworkError) {
    console.error('Network error:', error.message);
  }
}
```

## ⚙️ Configuration

### Basic Configuration

```typescript
const client = new AsterDEX({
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
  environment: 'mainnet', // 'mainnet' | 'testnet'
  timeout: 60000, // Request timeout in milliseconds
  recvWindow: 5000, // Receive window for signed requests
  enableRateLimiting: true, // Enable built-in rate limiting
  retryConfig: {
    maxRetries: 3,
    retryDelay: 1000,
    backoffMultiplier: 2
  }
});
```

### Custom Endpoints

```typescript
const client = new AsterDEX({
  baseUrl: {
    spot: 'https://custom-spot-api.example.com',
    futures: 'https://custom-futures-api.example.com',
    websocket: 'wss://custom-websocket.example.com'
  }
});
```

## 🔐 Authentication

The SDK supports all AsterDEX authentication types:

- **NONE** - Public endpoints, no authentication required
- **MARKET_DATA** - Market data endpoints, API key required
- **USER_STREAM** - User data streams, API key required
- **TRADE** - Trading endpoints, API key and signature required
- **USER_DATA** - Account endpoints, API key and signature required

Authentication is handled automatically based on the endpoint being called.

## 📊 Rate Limiting

The SDK includes built-in rate limiting to prevent exceeding API limits:

- Automatic request queuing and spacing
- Respect for `Retry-After` headers
- Configurable rate limits and backoff strategies
- Separate limits for different endpoint types

## 🌐 WebSocket Features

- **Automatic reconnection** with exponential backoff
- **Subscription management** with easy subscribe/unsubscribe
- **Combined streams** support for multiple symbols
- **User data streams** for real-time account updates
- **Ping/pong** handling for connection health
- **Error recovery** and connection state management

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## 📖 Examples

Check out the [examples directory](./examples) for complete working examples:

- [Demo file](./examples/demo.ts) - Complete spot/futures/websocket trading operations


## 🛠️ Development

### Prerequisites

- Node.js >= 18.0.0
- TypeScript >= 5.0.0

### Setup

```bash
# Clone the repository
git clone https://github.com/methodnumber13/asterdex-sdk.git
cd asterdex-sdk

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Run linting
npm run lint
```

### Building

```bash
# Build for production
npm run build

# Build in watch mode for development
npm run dev
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Reporting Issues

Please report issues on our [GitHub Issues](https://github.com/methodnumber13/asterdex-sdk/issues) page.

## 📞 Support

### SDK Support
- 🐛 **Issues & Bug Reports**: [GitHub Issues](https://github.com/methodnumber13/asterdex-sdk/issues)
- 💡 **Feature Requests**: [GitHub Issues](https://github.com/methodnumber13/asterdex-sdk/issues)
- 📖 **Documentation**: This README and inline code documentation

### AsterDEX Platform Support
For official AsterDEX platform support:
- 📖 Official Documentation: [docs.asterdex.com](https://docs.asterdex.com)
- 🌐 Website: [asterdex.com](https://www.asterdex.com)

## ⚠️ Disclaimer

**Important Notice:**
- This is an **unofficial SDK** and is **not affiliated with or endorsed by AsterDEX**
- This SDK is provided **as-is** without any warranties
- The maintainer is not responsible for any losses incurred while using this SDK
- Trading cryptocurrencies involves significant risk and can result in financial loss
- Always test thoroughly in a testnet environment before using in production
- Use at your own risk

## 📝 Maintainer

This SDK is maintained by [methodnumber13](https://github.com/methodnumber13).

---

Made with ❤️ by the community