# 🤖 Aster Futures Trading Bot

![Build](https://img.shields.io/badge/build-passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Tests](https://img.shields.io/badge/tests-passing-brightgreen)

An open-source TypeScript trading bot for Aster futures markets,
supporting multiple strategies, risk controls, and execution modes.

------------------------------------------------------------------------

## 🚀 Features

-   📈 Multiple trading strategies\
-   🧪 Dry-run & paper trading modes\
-   💰 Live trading support (use with caution)\
-   🔐 Environment variable validation with Zod\
-   🧠 Indicator-based decision engine\
-   🧾 Logging and persistent state\
-   🧪 Built-in test suite (Jest)\
-   ⚙️ TypeScript-first architecture

------------------------------------------------------------------------

## 🏗 Architecture Diagram

``` mermaid
flowchart LR
    A[Market Data] --> B[Indicators]
    B --> C[Strategies]
    C --> D[Signal Engine]
    D --> E[Execution Layer]
    E --> F[Exchange API]
    E --> G[State Storage]
```

------------------------------------------------------------------------

## 🧠 Strategy Development Guide

### 1. Create a strategy

``` ts
export class MyStrategy {
  evaluate(data) {
    if (data.rsi < 30) return "BUY";
    if (data.rsi > 70) return "SELL";
    return "HOLD";
  }
}
```

### 2. Register strategy

Add to `strategies/` and wire into engine.

### 3. Use indicators

Import from `indicators/` and compose logic.

------------------------------------------------------------------------

## 🔬 Backtesting Module Design

### Goal

Simulate strategies on historical data before live trading.

### Components

-   Data Loader (historical candles)
-   Simulation Engine
-   Execution Simulator
-   Metrics (PnL, win rate, drawdown)

``` mermaid
flowchart LR
    A[Historical Data] --> B[Simulation Engine]
    B --> C[Strategy]
    C --> D[Simulated Execution]
    D --> E[Metrics]
```

------------------------------------------------------------------------

## 📦 Installation

``` bash
npm install
```

------------------------------------------------------------------------

## ⚙️ Configuration

Create a `.env` file:

    API_KEY=your_api_key
    API_SECRET=your_api_secret
    MODE=dry-run
    SYMBOL=BTCUSDT

------------------------------------------------------------------------

## ▶️ Usage

### Run bot

``` bash
npm start
```

### Development mode

``` bash
npm run dev
```

### Run tests

``` bash
npm test
```

------------------------------------------------------------------------

## 🧪 Modes

  Mode      Description
  --------- ------------------------
  dry-run   No trades executed
  paper     Simulated trading
  live      Real trades (⚠️ risky)

------------------------------------------------------------------------

## 🏗 Project Structure

    src/
      engine/
      strategies/
      indicators/
      execution/
      utils/
    tests/

------------------------------------------------------------------------

## 🛡 Risk Disclaimer

This software is for educational purposes only.

Trading cryptocurrencies involves substantial risk. You can lose all
your capital.

Use at your own risk.

------------------------------------------------------------------------

## 🧪 Testing

``` bash
npm test -- --runInBand
```

------------------------------------------------------------------------

## 📄 License

MIT License

------------------------------------------------------------------------

## 🤝 Contributing

Pull requests are welcome. Please open an issue first to discuss
changes.

------------------------------------------------------------------------

## ⭐ Support

If you like this project, give it a star ⭐

------------------------------------------------------------------------

## 💰 Donate

If you like what I've built then share the love on chain
