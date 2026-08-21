/**
 * LI.FI Stellar trustline setup.
 *
 * Reads the published token manifest, diffs it against a collector account's
 * existing trustlines, and builds the `ChangeTrust` operations for whatever is
 * missing. Everything runs in the browser: no backend, no key ever leaves the
 * wallet, and the unsigned XDR is always offered so the transaction can be
 * reviewed or signed elsewhere.
 *
 * Reads and submits over Soroban RPC. Horizon is deprecated, and RPC can serve
 * both jobs here: the manifest names every asset up front, so the trustline
 * ledger keys can be built directly rather than enumerated.
 */

const RPC_URL = 'https://mainnet.sorobanrpc.com'
const NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC

/** Reserve locked per subentry, in XLM. A trustline is one subentry. */
const BASE_RESERVE = 0.5

/** Protocol cap on operations in a single transaction. */
const MAX_OPS_PER_TX = 100

/** Per-operation fee bid, in stroops. Well above base to survive surge. */
const FEE_PER_OP = '10000'

const STROOPS_PER_XLM = 10_000_000

/** `AUTHORIZED_FLAG` on `TrustLineEntry.flags`. */
const TRUSTLINE_AUTHORIZED = 1

const { xdr, Asset, Account, Keypair, StrKey, TransactionBuilder, Operation } =
  StellarSdk

/** Everything the page has loaded or derived. */
const state = {
  manifest: null,
  address: null,
  account: null,
  rows: [],
  wallet: null,
  batches: [],
}

// ---------------------------------------------------------------- RPC

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`)
  return body.result
}

const accountLedgerKey = (address) =>
  xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
    })
  ).toXDR('base64')

const trustlineLedgerKey = (address, code, issuer) =>
  xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: new Asset(code, issuer).toTrustLineXDRObject(),
    })
  ).toXDR('base64')

/**
 * Reads ledger entries in chunks, keyed by the request key. The RPC omits keys
 * that do not resolve and does not guarantee ordering, so absence is meaningful
 * and every lookup goes through the key.
 */
async function readLedgerEntries(keys) {
  const found = new Map()
  for (let i = 0; i < keys.length; i += MAX_OPS_PER_TX) {
    const result = await rpc('getLedgerEntries', {
      keys: keys.slice(i, i + MAX_OPS_PER_TX),
    })
    for (const entry of result.entries ?? []) {
      found.set(entry.key, xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64'))
    }
  }
  return found
}

/**
 * Pulls the sponsorship counts and selling liabilities off the `AccountEntry`
 * extension chain. Both feed the reserve calculation: sponsored subentries are
 * paid for by someone else, and liabilities are already spoken for.
 */
function readAccountExtensions(account) {
  const extensions = { numSponsoring: 0, numSponsored: 0, sellingLiabilities: 0 }
  const ext = account.ext()
  if (ext.switch() !== 1) return extensions

  const v1 = ext.v1()
  extensions.sellingLiabilities = Number(v1.liabilities().selling().toString())

  const v1Ext = v1.ext()
  if (v1Ext.switch() === 2) {
    const v2 = v1Ext.v2()
    extensions.numSponsoring = v2.numSponsoring()
    extensions.numSponsored = v2.numSponsored()
  }
  return extensions
}

/**
 * Reads the collector account plus a trustline entry for every manifest asset,
 * in one round-trip. A trustline that exists but is unauthorized is reported
 * separately: creating it was not enough, and a transfer to it still fails.
 */
async function readAccount(address, assets) {
  const accountKey = accountLedgerKey(address)
  const assetKeys = new Map(
    assets.map((asset) => [
      trustlineLedgerKey(address, asset.code, asset.issuer),
      asset,
    ])
  )
  const entries = await readLedgerEntries([accountKey, ...assetKeys.keys()])

  const accountData = entries.get(accountKey)
  if (accountData === undefined) return { exists: false }

  const account = accountData.account()
  const thresholds = account.thresholds()
  const extensions = readAccountExtensions(account)

  const trustlines = new Map()
  for (const [key, asset] of assetKeys) {
    const data = entries.get(key)
    if (data === undefined) continue
    trustlines.set(asset.contract, {
      authorized: (data.trustLine().flags() & TRUSTLINE_AUTHORIZED) !== 0,
    })
  }

  const subEntries = account.numSubEntries()
  const minimumBalance =
    (2 + subEntries + extensions.numSponsoring - extensions.numSponsored) *
    BASE_RESERVE
  const balance = Number(account.balance().toString()) / STROOPS_PER_XLM

  return {
    exists: true,
    sequence: account.seqNum().toString(),
    balance,
    available:
      balance - minimumBalance - extensions.sellingLiabilities / STROOPS_PER_XLM,
    masterWeight: thresholds[0],
    // ChangeTrust is a medium-threshold operation.
    mediumThreshold: thresholds[2],
    trustlines,
  }
}

// ------------------------------------------------------------- Diffing

/**
 * Classifies every manifest asset against the account. `unauthorized` is the
 * case worth surfacing loudly: the trustline is visibly present, so nothing
 * looks wrong, but the issuer has not authorized it and transfers still fail.
 */
function buildRows() {
  return state.manifest.assets.map((asset) => {
    const trustline = state.account.trustlines.get(asset.contract)
    const status =
      trustline === undefined
        ? 'missing'
        : trustline.authorized
          ? 'present'
          : 'unauthorized'
    return { ...asset, status }
  })
}

const missingRows = () => state.rows.filter((row) => row.status === 'missing')

/**
 * Splits the missing assets into transactions. Each is built against the same
 * starting sequence number, so they must be submitted in order, and the account
 * is re-read between submissions rather than pre-chaining the whole set — one
 * failure part-way through would otherwise invalidate every later transaction.
 */
function buildBatches(rows) {
  const batches = []
  for (let i = 0; i < rows.length; i += MAX_OPS_PER_TX) {
    batches.push(rows.slice(i, i + MAX_OPS_PER_TX))
  }
  return batches
}

/**
 * Builds one unsigned transaction. The `changeTrust` limit is left at the SDK
 * default of int64 max, matching the unlimited trustline that the SAC's CAP-73
 * `trust()` would have opened.
 */
function buildTransaction(batch, sequence) {
  const builder = new TransactionBuilder(new Account(state.address, sequence), {
    fee: FEE_PER_OP,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
  for (const asset of batch) {
    builder.addOperation(
      Operation.changeTrust({ asset: new Asset(asset.code, asset.issuer) })
    )
  }
  return builder.setTimeout(600).build()
}

// ------------------------------------------------------------- Wallets

/**
 * Injected wallet adapters. Each extension exposes its own API, so the shape is
 * normalised here. Hardware wallets and multisig accounts are deliberately not
 * covered — those go through the unsigned XDR, which is always available.
 */
const WALLETS = [
  {
    id: 'freighter',
    name: 'Freighter',
    detect: () => window.freighterApi,
    connect: async () => {
      const { address, error } = await window.freighterApi.requestAccess()
      if (error) throw new Error(error)
      return address
    },
    sign: async (txXdr, address) => {
      const { signedTxXdr, error } = await window.freighterApi.signTransaction(
        txXdr,
        { networkPassphrase: NETWORK_PASSPHRASE, address }
      )
      if (error) throw new Error(error)
      return signedTxXdr
    },
  },
  {
    id: 'xbull',
    name: 'xBull',
    detect: () => window.xBullSDK,
    connect: async () => {
      await window.xBullSDK.connect({
        canRequestPublicKey: true,
        canRequestSign: true,
      })
      return window.xBullSDK.getPublicKey()
    },
    sign: (txXdr, address) =>
      window.xBullSDK.signXDR(txXdr, {
        network: NETWORK_PASSPHRASE,
        publicKey: address,
      }),
  },
  {
    id: 'albedo',
    name: 'Albedo',
    detect: () => window.albedo,
    connect: async () => (await window.albedo.publicKey({})).pubkey,
    sign: async (txXdr) =>
      (await window.albedo.tx({ xdr: txXdr, network: 'public' }))
        .signed_envelope_xdr,
  },
  {
    id: 'rabet',
    name: 'Rabet',
    detect: () => window.rabet,
    connect: async () => (await window.rabet.connect()).publicKey,
    sign: async (txXdr) => (await window.rabet.sign(txXdr, 'mainnet')).xdr,
  },
]

const detectWallets = () => WALLETS.filter((wallet) => wallet.detect())

// ---------------------------------------------------------- Submission

/** Turns a transaction result XDR into its result code, e.g. `txBadAuth`. */
function describeResult(errorResultXdr) {
  try {
    return xdr.TransactionResult.fromXDR(errorResultXdr, 'base64')
      .result()
      .switch().name
  } catch {
    return 'unknown error'
  }
}

const EXPLANATIONS = {
  txBadAuth: 'Not enough signatures — this account needs more than one signer.',
  txInsufficientBalance:
    'Not enough XLM to cover the reserve for these trustlines.',
  txBadSeq: 'Sequence number is stale — reload and try again.',
  txFailed: 'An operation failed; the most likely cause is an unfunded reserve.',
}

/** Submits a signed transaction and polls until the network reports an outcome. */
async function submitTransaction(signedXdr) {
  const sent = await rpc('sendTransaction', { transaction: signedXdr })
  if (sent.status === 'ERROR') {
    const code = describeResult(sent.errorResultXdr)
    throw new Error(`${code}. ${EXPLANATIONS[code] ?? ''}`.trim())
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const result = await rpc('getTransaction', { hash: sent.hash })
    if (result.status === 'SUCCESS') return sent.hash
    if (result.status === 'FAILED') {
      const code = describeResult(result.resultXdr)
      throw new Error(`${code}. ${EXPLANATIONS[code] ?? ''}`.trim())
    }
  }
  throw new Error(`Timed out waiting for ${sent.hash}`)
}

// ------------------------------------------------------------- Rendering

const $ = (id) => document.getElementById(id)

const setStatus = (message, kind = 'info') => {
  const el = $('status')
  el.textContent = message
  el.className = `status ${kind}`
  el.hidden = !message
}

const short = (value) => `${value.slice(0, 6)}…${value.slice(-6)}`

const STATUS_LABEL = {
  missing: 'Missing',
  present: 'Ready',
  unauthorized: 'Needs issuer approval',
}

function renderTable() {
  const rows = state.rows
    .map(
      (row) => `
      <tr>
        <td><strong>${row.code}</strong></td>
        <td class="mono">${short(row.issuer)}</td>
        <td><span class="pill ${row.status}">${STATUS_LABEL[row.status]}</span></td>
        <td>${row.authRequired ? '<span class="pill gated">Issuer authorization</span>' : ''}</td>
      </tr>`
    )
    .join('')
  $('assets').innerHTML = `
    <table>
      <thead>
        <tr><th>Asset</th><th>Issuer</th><th>Trustline</th><th>Notes</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

/**
 * Renders the summary and decides which actions to offer. A multisig account
 * cannot complete the signing flow in the page, so it is routed to the XDR
 * before it signs anything rather than after a confusing `txBadAuth`.
 */
function renderSummary() {
  const missing = missingRows()
  const cost = missing.length * BASE_RESERVE
  const underfunded = state.account.available < cost
  const multisig = state.account.mediumThreshold > state.account.masterWeight

  const notes = []
  if (missing.length === 0) {
    notes.push(
      '<p class="ok">Every asset in the manifest already has a trustline.</p>'
    )
  }
  if (underfunded && missing.length > 0) {
    notes.push(
      `<p class="warn">Not enough XLM: ${missing.length} trustlines lock
       <strong>${cost} XLM</strong> but only
       <strong>${state.account.available.toFixed(2)} XLM</strong> is available.
       Fund the account before continuing.</p>`
    )
  }
  if (multisig) {
    notes.push(
      `<p class="warn">This account needs more than one signature
       (medium threshold ${state.account.mediumThreshold}, master key weight
       ${state.account.masterWeight}). Signing in this page will not be enough —
       download the XDR and sign it through your usual process.</p>`
    )
  }
  const unauthorized = state.rows.filter((r) => r.status === 'unauthorized')
  if (unauthorized.length > 0) {
    notes.push(
      `<p class="warn">${unauthorized.length} trustline(s) exist but are not
       authorized by the issuer: ${unauthorized.map((r) => r.code).join(', ')}.
       Transfers will still fail until the issuer approves them.</p>`
    )
  }

  $('summary').innerHTML = `
    <dl>
      <div><dt>Account</dt><dd class="mono">${state.address}</dd></div>
      <div><dt>Balance</dt><dd>${state.account.balance.toFixed(2)} XLM</dd></div>
      <div><dt>Available</dt><dd>${state.account.available.toFixed(2)} XLM</dd></div>
      <div><dt>Missing trustlines</dt><dd>${missing.length} of ${state.rows.length}</dd></div>
      <div><dt>Reserve needed</dt><dd>${cost} XLM</dd></div>
    </dl>
    ${notes.join('')}`

  const canSign = missing.length > 0 && !underfunded && !multisig
  $('actions').hidden = missing.length === 0
  $('sign').hidden = !canSign
  $('sign').textContent =
    state.batches.length > 1
      ? `Create ${missing.length} trustlines (${state.batches.length} transactions)`
      : `Create ${missing.length} trustlines`
}

function render() {
  state.batches = buildBatches(missingRows())
  renderSummary()
  renderTable()
  $('results').hidden = false
}

// --------------------------------------------------------------- Actions

async function load(address) {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    setStatus('That is not a valid Stellar account address (G…).', 'error')
    return
  }
  setStatus('Reading account…')
  try {
    const account = await readAccount(address, state.manifest.assets)
    if (!account.exists) {
      setStatus(
        'That account does not exist on mainnet yet — it needs to be funded first.',
        'error'
      )
      return
    }
    state.address = address
    state.account = account
    state.rows = buildRows()
    render()
    setStatus('')
  } catch (error) {
    setStatus(error.message, 'error')
  }
}

/** Rebuilds every pending transaction and hands back their unsigned XDRs. */
function unsignedXdrs() {
  return state.batches.map((batch) =>
    buildTransaction(batch, state.account.sequence).toXDR()
  )
}

/**
 * Signs and submits each batch in turn, re-reading the account between them so
 * the next transaction picks up the sequence number the network actually has.
 */
async function signAndSubmit() {
  const wallet = state.wallet
  if (!wallet) {
    setStatus('Connect a wallet first.', 'error')
    return
  }
  $('sign').disabled = true
  try {
    for (let i = 0; i < state.batches.length; i++) {
      setStatus(`Transaction ${i + 1} of ${state.batches.length}: awaiting signature…`)
      const tx = buildTransaction(state.batches[i], state.account.sequence)
      const signed = await wallet.sign(tx.toXDR(), state.address)

      setStatus(`Transaction ${i + 1} of ${state.batches.length}: submitting…`)
      const hash = await submitTransaction(signed)
      setStatus(`Transaction ${i + 1} confirmed (${short(hash)}). Re-reading account…`)

      state.account = await readAccount(state.address, state.manifest.assets)
      state.rows = buildRows()
      state.batches = buildBatches(missingRows())
      render()
    }
    setStatus('All trustlines created.', 'ok')
  } catch (error) {
    setStatus(error.message, 'error')
  } finally {
    $('sign').disabled = false
  }
}

function renderWallets() {
  const wallets = detectWallets()
  if (wallets.length === 0) {
    $('wallets').innerHTML =
      '<p class="muted">No wallet extension detected. You can still load an address and download the XDR.</p>'
    return
  }
  $('wallets').innerHTML = wallets
    .map((w) => `<button data-wallet="${w.id}" class="secondary">${w.name}</button>`)
    .join('')
  for (const button of $('wallets').querySelectorAll('[data-wallet]')) {
    button.addEventListener('click', async () => {
      const wallet = wallets.find((w) => w.id === button.dataset.wallet)
      try {
        const address = await wallet.connect()
        state.wallet = wallet
        $('address').value = address
        await load(address)
      } catch (error) {
        setStatus(`${wallet.name}: ${error.message}`, 'error')
      }
    })
  }
}

// ----------------------------------------------------------------- Boot

async function main() {
  try {
    const response = await fetch('./tokens.json')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    state.manifest = await response.json()
  } catch (error) {
    setStatus(`Could not load tokens.json: ${error.message}`, 'error')
    return
  }

  if (state.manifest.network !== 'public') {
    setStatus(`Manifest is for ${state.manifest.network}, not mainnet.`, 'error')
    return
  }
  $('manifest-meta').textContent =
    `${state.manifest.assets.length} assets · generated ${state.manifest.generatedAt.slice(0, 10)}`

  renderWallets()

  $('load').addEventListener('click', () => load($('address').value.trim()))
  $('address').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') load($('address').value.trim())
  })
  $('sign').addEventListener('click', signAndSubmit)
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(unsignedXdrs().join('\n'))
    setStatus('Unsigned XDR copied.', 'ok')
  })
  $('download').addEventListener('click', () => {
    const blob = new Blob([unsignedXdrs().join('\n')], { type: 'text/plain' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `trustlines-${state.address.slice(0, 8)}.xdr.txt`
    link.click()
    URL.revokeObjectURL(link.href)
  })

  const preset = new URLSearchParams(location.search).get('address')
  if (preset) {
    $('address').value = preset
    await load(preset)
  }
}

main()
