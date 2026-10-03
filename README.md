# Stempel

A mobile-first loyalty app for students. The demo includes student, venue, and administrator dashboards, a local SQLite database, and a complete staff-approved stamp and reward flow.

## Run locally

### One click on Windows

Open the project folder and double-click **`OPEN-STEMPEL.bat`**. The launcher checks for Node.js, starts the server, and opens the app in your default browser automatically. Keep the launcher window open while using the app.

If the launcher says that Node.js is missing, install the LTS version from [nodejs.org](https://nodejs.org), then double-click the file again.

### Terminal

```bash
npm start
```

The app will be available at `http://localhost:3000`. Demo account credentials are shown on the login screen.

## Tests

```bash
npm test
```

The integration test covers 10 separate purchases, duplicate approval prevention, reward redemption, and the beginning of a new card.

## Apple Wallet and Google Wallet

The administrator dashboard reports the real configuration status. Integrations remain clearly marked as requiring configuration until the server receives the required environment variables (`APPLE_PASS_CERT`, `APPLE_PASS_KEY`, `GOOGLE_WALLET_ISSUER`, and `GOOGLE_WALLET_KEY`). Credentials are never exposed to client-side code.
