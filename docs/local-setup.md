# Local development

This project uses test assets on a loopback-only local ledger. It does not connect to Mainnet. Compiler artifacts, private data and dependencies are ignored by Git.

Verified host: Windows, Node 24.18.0/npm 11.16.0, Ubuntu 24.04 under WSL2, Docker Engine 29.1.3 in WSL. Windows' `compact.exe` is a filesystem compression utility, **not** the Compact compiler. This project's compilation script uses the pinned Linux compiler explicitly.

From the repository in PowerShell:

```powershell
wsl -d Ubuntu-24.04 -- docker version
powershell -ExecutionPolicy Bypass -File scripts/install-compiler.ps1
npm.cmd ci --ignore-scripts
npm.cmd run compile:fast
npm.cmd run test:native
npm.cmd run compile
```

The compiler's upstream wrapper and installer mishandle directory names containing spaces. The install script verifies the official asset checksum and extracts it directly. Compilation invokes `./compactc` from its own directory to avoid that wrapper defect.

Linux x86-64 uses `bash scripts/install-compiler.sh`, then the same npm commands (without `.cmd`). See `compose.yaml` and network test scripts for the actual local proving and settlement gates. Use only an isolated development node: genesis fixture seeds are public test material and must never hold remote-network funds.

If WSL has Docker Engine but lacks its Compose plugin, run `powershell -ExecutionPolicy Bypass -File scripts/install-compose.ps1`. This installs the checksum-verified Compose 5.7.0 binary inside `.tools/`; it does not change the system installation. `scripts/local-network.sh` selects the installed plugin or this local binary.

The wallet test project uses dedicated host ports 16300 (prover), 18088 (indexer), and 19944 (node). Preserve other Midnight projects using the usual ports. Do not run a global Docker cleanup or WSL shutdown while another project is working. Keep an Ubuntu terminal open while running tests from Windows; a WSL session lifetime interruption was observed during initial setup.

```powershell
wsl -d Ubuntu-24.04 -- bash scripts/local-network.sh up
node tests/network/upstream-smoke.mjs
node tests/network/private-vault.mjs
node tests/network/durable-vault.mjs
wsl -d Ubuntu-24.04 -- bash scripts/local-network.sh status
```

Run the network scripts sequentially: they share disposable genesis wallets within this isolated test chain. Never interpret a provider completion counter alone as a circuit proof: only a finalized contract call that exercised the circuit establishes that result.

## Version boundary

The [official support matrix](https://docs.midnight.network/relnotes/support-matrix), rechecked 6 November 2026, selects compiler 0.31.1, Compact runtime 0.16.0, on-chain runtime 3.0.0, Midnight.js/testkit 4.1.1, wallet SDK 1.2.0, node 1.0.400 and proof server 8.1.3. Ledger npm 8.1.2 and ZKIR 2.1.1 follow the official examples. The lockfile records the full resolved dependency set.

Local indexer 4.3.5 is the available upstream development-network image. It is **not** the unpublished Preprod 4.3.302 image. No Preprod compatibility or settlement is claimed from the local result.

Do not run a bare `compact update` or unpinned Midnight install: newer compilers can target a different ledger. `--skip-zk` generates contract/runtime artifacts without proving keys; it cannot establish proof generation.

## Recovery boundary

Keep private policy openings, coin nonces/salts and qualified coin indices along with request records. A wallet seed alone is insufficient. An uncertain submission stays unresolved until chain evidence establishes its outcome. The current network harness is a test harness; inspect the verification record for which production runner/recovery paths actually exist.
