WhatsApp Group Manager (Baileys-Based)
A Node.js automation tool built with the Baileys WebSocket library. This tool allows you to connect to WhatsApp via QR code, list your current groups, export member lists to CSV, and import members into groups using randomized "human-like" delays to protect your account from bans.

🚀 Features
WebSocket Connection: Real-time connection without a headless browser.

QR Authentication: Secure login with persistent session storage in ./auth_store.

Member Export: One-click extraction of group participants into formatted CSV files.

Safe Import: Natural human behavior simulation using Gaussian Delays and "Coffee Breaks" during bulk additions.

Modular Architecture: Clean separation between connection logic and group management.

🛠️ Installation
1. Prerequisites
Ensure you have Node.js (v16.x or higher) installed on your machine.

2. Clone and Prepare
Create your project directory and move the provided files into it:

Bash
mkdir wa-group-manager
cd wa-group-manager
3. Install Dependencies
Run the following command to install the required libraries:

Bash
npm install @whiskeysockets/baileys qrcode-terminal csv-writer csv-parser
4. Setup Folders
Create an exports folder to store your CSV files:

Bash
mkdir exports
📖 How to Run
Step 1: Start the Application
Launch the script using Node:

Bash
node index.js
Step 2: Authentication
A QR Code will appear in your terminal.

Open WhatsApp on your phone -> Settings -> Linked Devices -> Link a Device.

Scan the terminal QR code.

Your session will be saved in the /auth_store folder so you won't need to scan again.

Step 3: Group Selection & Export
Once connected, the script will:

Fetch all groups you are currently a member of.

Display the list in the terminal.

Automatically generate a CSV in the /exports folder for the selected group.

🛡️ "Human-Way" Import Settings
The system is pre-configured to avoid detection by WhatsApp's anti-spam algorithms:

Variable Delay: Each "Add" action waits between 20 and 50 seconds (randomized).

The Break Rule: After every 5 successful additions, the script pauses for 2 minutes to simulate a user taking a break.

Privacy Handling: If a user has "Who can add me to groups" set to "My Contacts," the script handles the 403 error gracefully without crashing.

⚠️ Safety Warnings
Admin Rights: You must be an Admin of the target group to add members.

Account Age: Do not use this tool for bulk adding on a brand-new WhatsApp account. "Warm up" the account by chatting manually for a few days first.

Limits: Even with delays, avoid adding more than 50-100 people per day to stay under the radar.