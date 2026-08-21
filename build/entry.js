/**
 * Bundle entry. Produces `vendor/bundle.min.js`, which exposes:
 *   window.StellarSdk   — the Stellar SDK, used directly by app.js
 *   window.LifiWallets  — the Wallets Kit plus the wallet modules we enable
 *
 * The SDK is bundled rather than kept external: an external import compiles to
 * a bare `require()`, which no browser can resolve.
 *
 * Trezor is deliberately absent — its `@trezor/connect-web` alpha pulls Node
 * built-ins (`crypto`) that cannot be bundled for the browser.
 */
import * as StellarSdk from '@stellar/stellar-sdk'
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk'

import { LedgerModule } from '@creit.tech/stellar-wallets-kit/modules/ledger'
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter'
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull'
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo'
import { RabetModule } from '@creit.tech/stellar-wallets-kit/modules/rabet'
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr'
import { HanaModule } from '@creit.tech/stellar-wallets-kit/modules/hana'

window.StellarSdk = StellarSdk
window.LifiWallets = {
  StellarWalletsKit,
  modules: [
    LedgerModule,
    FreighterModule,
    xBullModule,
    AlbedoModule,
    RabetModule,
    LobstrModule,
    HanaModule,
  ],
}
