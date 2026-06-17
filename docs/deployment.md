# Deployment — GCP e2-small VM

One small VM runs the whole stack under Docker Compose. No public ports except
SSH; FreqUI is reached through an SSH tunnel.

## 1. Provision the VM

- **Machine**: e2-small, Ubuntu 24.04 LTS, region `africa-south1` (low latency
  to your VALR/Binance flow).
- **Static IP**: reserve one — you'll IP-restrict the Binance key to it.
- **Firewall (UFW)**: SSH only.

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker "$USER"   # re-login afterwards; run Docker non-root
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
```

## 2. Binance API key (auto-execution)

Create the key the Concierge will use:

1. Binance → API Management → Create API (System generated / HMAC).
2. Permissions: **Enable Spot & Margin Trading = ON**.
   **Enable Withdrawals = OFF** (leave it off forever — orders never need it).
3. **Restrict access to trusted IPs only** → enter the VM's static IP.
4. Start with a **testnet** key (`testnet.binance.vision`) and
   `BINANCE_TESTNET=1`. Only swap in a mainnet key after the testnet
   validation drill is green (see `testnet-validation.md`).

Screenshot checklist (keep with your records):
- [ ] key shows "Spot & Margin Trading" enabled
- [ ] key shows "Withdrawals" disabled
- [ ] key shows the VM static IP under IP access restriction

## 3. Secrets

```bash
git clone <repo> ~/signal-engine && cd ~/signal-engine
cp .env.example .env
nano .env          # fill in keys, Telegram, FreqUI secrets, risk params
chmod 600 .env     # owner-only
```

Keep `KILL_SWITCH=1` and `BINANCE_TESTNET=1` until you have validated and are
ready to arm. Generate FreqUI secrets with `openssl rand -hex 32`.

## 4. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f concierge
```

The Concierge boot banner states the mode (`KILL SWITCH ON` / `ARMED on
TESTNET` / `ARMED on MAINNET`). It survives reboots (`restart: unless-stopped`
+ persisted state volume) and reconciles open positions on boot.

## 5. FreqUI via SSH tunnel (never public)

From your workstation:

```bash
ssh -L 8080:127.0.0.1:8080 user@vm-host
# then browse http://127.0.0.1:8080  (login: freqtrader / FREQUI_PASSWORD)
```

Tailscale is a fine alternative; the port is never opened in UFW either way.

## 6. Healthcheck cron (5-minute liveness)

```bash
crontab -e
# add:
*/5 * * * * /home/USER/signal-engine/scripts/healthcheck.sh >> /var/log/signal-healthcheck.log 2>&1
```

It pings the Concierge `/healthz` and freqtrade `/api/v1/ping`; on failure it
sends a Telegram alert. A killed container therefore pages you within 5 min.

## 7. Sentry

Set `SENTRY_DSN` in `.env`. The Concierge reports unhandled errors and crashes
on the money-moving path. Tag/environment is `testnet` or `mainnet`
automatically.

## 8. Updates (deliberate, never auto)

```bash
./scripts/deploy.sh user@vm-host          # from your workstation: pull + up -d --build
```

The freqtrade image tag is pinned in `docker-compose.prod.yml`. Bump it only
after reviewing the freqtrade changelog — no auto-update.

## Reboot / kill drills (acceptance)

- `sudo reboot` → both containers return; Concierge reconciles positions.
- `docker kill concierge` → healthcheck Telegrams you within 5 min; Docker
  restarts it; state is intact from the volume.
- FreqUI is unreachable except through the tunnel.
