📄 README.md
Quantivo CRM | AI-Powered WhatsApp Automation
A professional, high-performance CRM built on the Baileys V7 Engine, designed for bulk member management and AI-driven customer engagement.

🚀 Key Features
AI Auto-Reply: Integrated with Google Gemini 1.5 Flash for RAG-based automated responses.

V7 Engine Power: Utilizes LID mapping and human-like delays to ensure account safety.

Bulk Operations: Export group members to CSV and import contacts via Excel/CSV.

Knowledge Base: Fully customizable "brain" for the AI via the dashboard.

🛠️ Installation & Local Setup
Clone the repository:

Bash
git clone <your-repo-link>
cd bbidar-v2
Install dependencies:

Bash
npm install
Environment Setup:
Ensure you have a settings.json and auth_store/ folder (managed by the app).

Run the app:

Bash
node server.js
Access at http://localhost:3000

☁️ Cloudflare Deployment Guide (Cloudflare Tunnel)
Since WhatsApp requires a persistent connection (Socket.io + Long-running process), you cannot run the server.js directly on a Cloudflare Worker. The best approach is to use Cloudflare Tunnel. This allows you to run the server on your local machine or a VPS in Yerevan while exposing it securely through a Cloudflare .dev or custom domain.

1. Install Cloudflared
On your server/machine, install the Cloudflare tunnel client:

Linux: sudo apt install cloudflared

Mac: brew install cloudflare/cloudflare/cloudflared

2. Authenticate & Create Tunnel
Bash
cloudflared tunnel login
cloudflared tunnel create quantivo-crm
3. Route Traffic
Replace your-domain.com with your actual domain or use a tunnel-specific hostname:

Bash
cloudflared tunnel route dns quantivo-crm crm.your-domain.com
4. Run the Tunnel
Point the tunnel to your local Quantivo port:

Bash
cloudflared tunnel run --url http://localhost:3000 quantivo-crm
5. Why use this for Quantivo?
No Open Ports: You don't need to open Port 3000 on your router or firewall.

SSL Included: Cloudflare provides the HTTPS certificate automatically.

V7 Security: Since the code still runs on your machine, your auth_store (WhatsApp keys) stays local and never touches the cloud.

⚠️ Security Reminder
As a software engineer, remember to keep your .env and settings.json out of your public commits.