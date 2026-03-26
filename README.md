Quantivo CRM | AI-Powered WhatsApp Automation
High-performance CRM built on Baileys V7 Engine (Multi-Device) with Mandatory Data-Sync Guard.

🚀 Key Features
Smart Sync Engine (New): دارای مکانیزم انتظار ۶۰ ثانیه‌ای برای پایداری کامل دیتا و جلوگیری از تکرار گروه‌ها در groupsCache.

V7 Engine Power: استفاده از LID Mapping و شبیه‌سازی دقیق Browser برای کاهش ریسک بن (Anti-Ban).

Bulk Operations: استخراج اعضای گروه به CSV و وارد کردن انبوه مخاطبین از طریق Excel/CSV.

Fallback Fetch: در صورت عدم دریافت تاریخچه خودکار از واتس‌اپ، سیستم پس از ۶۰ ثانیه به صورت اجباری (Forced Fetch) لیست گروه‌ها را واکشی می‌کند.

AI Auto-Reply: یکپارچه‌سازی شده با Google Gemini 1.5 Flash برای پاسخگویی هوشمند (غیرفعال در نسخه دمو).

🛠️ Architecture & Logic Flow
برای درک بهتر تیم توسعه، منطق اتصال در نسخه جدید به شرح زیر است:

Connection: برقراری اتصال و نمایش QR.

Sync Window (60s): قفل شدن رابط کاربری و سایدبار برای جلوگیری از درخواست‌های نامعتبر تا زمان پایداری دیتا.

Data Hydration: دریافت گروه‌ها از رویداد messaging-history.set.

Fallback Trigger: اگر بعد از ۶۰ ثانیه دیتایی دریافت نشد، متد finalizeSync لیست را مستقیماً از سرورهای واتس‌اپ بیرون می‌کشد.

🛠️ Installation & Local Setup
Clone the repository:

Bash
git clone <your-repo-link>
cd bbidar-v2
Install dependencies:

Bash
npm install
Run the app:

Bash
node server.js
Access at: http://localhost:3000

☁️ Cloudflare Deployment (Tunnel Guide)
از آنجایی که واتس‌اپ نیاز به یک Persistent Connection (اتصال مداوم) دارد، اجرای مستقیم روی Cloudflare Workers امکان‌پذیر نیست. استفاده از Cloudflare Tunnel پیشنهاد می‌شود:

Install Cloudflared:

sudo apt install cloudflared (Linux)

Auth & Create Tunnel:

Bash
cloudflared tunnel login
cloudflared tunnel create quantivo-crm
Run & Route:

Bash
cloudflared tunnel run --url http://localhost:3000 quantivo-crm
مزیت اصلی: تمام کلیدهای امنیتی در پوشه auth_store روی سرور محلی شما باقی می‌ماند و هرگز وارد فضای ابری نمی‌شود.

⚠️ Security & Development Notes
Anti-Ban Safety: به هیچ عنوان زمان delay را در تابع processImports کاهش ندهید. این بازه (۳۰ تا ۵۰ ثانیه) برای شبیه‌سازی رفتار انسانی تنظیم شده است.

Sync Logic: اگر گروه‌ها در داشبورد نمایش داده نمی‌شوند، حتماً کنسول سرور را چک کنید تا از وضعیت Timeout in AwaitingInitialSync مطلع شوید.

LID Mapping: این نسخه از LID (Identity شناسایی جدید واتس‌اپ) پشتیبانی می‌کند تا پایداری سشن‌ها افزایش یابد.

Quantivo CRM Team - Reliability over Speed.