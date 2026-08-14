# مرصد المتداولين — سجل المشروع

> لاستئناف العمل: اقرأ هذا الملف أولاً لفهم البنية الكاملة قبل أي تعديل.

آخر تحديث: أغسطس ٢٠٢٦

## الروابط
- الموقع: https://bins-indol.vercel.app
- المستودع: github.com/zerkq8/bins
- الاستضافة: Vercel — منطقة fra1 (إلزامية، باينس تحجب أمريكا)
- قاعدة البيانات: Supabase — مشروع bins، eu-central-1

## ما يفعله الموقع (خمسة أقسام)
1. **المتداولون** — أعلى ١٠ عائداً (٩٠ يوماً)، علامات خطر حمراء تحت كل اسم،
   علامة 🟢/🔴 حية تظهر هل مراكزه ظاهرة، تقييم مخاطر كامل + آخر ١٠ صفقات
2. **الأجدر بالثقة** — فلترة صارمة (سجل ٤ أشهر، تراجع <٣٥٪، ناسخون رابحون)
3. **متابعتي** — تبويبان فرعيان:
   - متداولون: قائمة خاصة بمفتاح دخول شخصي، دخول/خروج/حذف حساب،
     منحدر عائد، تنبيهات تيليجرام
   - عملات: متابعة أسعار، تنبيه عند وصول القاع (١٨٠ يوم)
4. **أدواتي** — قراءة عملة (+ سياق تاريخي صادق)، حاسبة مخاطر، دفتر صفقات
5. **إشارات حية** — إجماع المراكز المفتوحة عبر أعلى ٢٠ متداولاً

**الفلسفة:** أداة فحص تكشف من لا يستحق المتابعة. لا توصيات، لا إخفاء خسائر.

## بنية المستودع (api/ عند الحد الأقصى ١٢ ملفاً — Vercel Hobby)

index.html
lib/binance.js الاتصال بباينس + توحيد الحقول + __internal exports
lib/market.js بيانات السوق + السياق التاريخي + getPeriodExtremes
lib/watchdb.js المتابعة + دفتر الصفقات
lib/alerts.js مقارنة اللقطات + إرسال تيليجرام (دفعات متناوبة)
lib/coinalerts.js متابعة العملات + تنبيه القاع
api/top.js api/search.js api/ranked.js api/signals.js
api/watch.js api/journal.js api/market.js api/pattern.js
api/coinwatch.js api/alerts.js api/status.js
api/trader/[id].js
vercel.json package.json

⚠️ عند إضافة ملف API جديد، احذف واحداً أولاً — الحد ١٢ صارم.

## المسارات المؤكدة (Copy Trading — غير موثّقة رسمياً)
الجذر: binance.com/bapi/futures/v1/friendly/future/copy-trade
- القائمة: POST /home-page/query-list
- تفاصيل: GET /lead-portfolio/detail?portfolioId={id}
- مراكز مفتوحة: GET /lead-data/positions?portfolioId={id}
  ⚠️ تُعيد ~٧٧٧ رمزاً (كل الأسواق) لا المفتوحة فقط — فلترة positionAmount!=0 إلزامية
  ⚠️ لا حقل roi/roe — يُحسب من: (ربح ÷ هامش) × ١٠٠
  ⚠️ isolatedWallet = الهامش الحقيقي (فقط في وضع isolated، لا cross)
  ⚠️ لا وقت فتح المركز — الحقل غير موجود من باينس أصلاً
- صفقات مغلقة: POST /lead-portfolio/position-history
  roi يأتي ككسر نصي "0.94" = 94% — يُضرب ×100

## قواعد مكتشفة بالتجربة
- ROI في القائمة نسبة جاهزة (3867 = 3867%) — لا تُضرب
- لا بحث نصي — تصفية محلية عبر عدة صفحات، أو بحث بـ portfolioId مباشرة
- إجمالي المتداولين: ~8,668
- Vercel Hobby: حد ١٠ ثوانٍ صارم للدالة رغم maxDuration في vercel.json
- تجاوز ١٢ ملف API يمنع النشر بالكامل (رسالة: "No more than 12 Serverless Functions")
- Redeploy في Vercel يعيد نفس commit القديم — commit جديد فعلي مطلوب لسحب التحديثات
- Smart Money (منصة باينس الأحدث) نظام منفصل كلياً بمعرّفات مختلفة — لا يعمل مع موقعنا

## نظام التنبيهات (lib/alerts.js)
- BATCH_SIZE=6 لكل استدعاء (تجنب 504 timeout)
- alert_cursor يحفظ "أين توقفنا" بين الاستدعاءات — **جدول إلزامي**،
  بدونه cursor يبقى صفراً دائماً ويُعاد فحص نفس ٦ الأوائل للأبد
- matchPositions() يقارن سعر الدخول أيضاً (فرق >1.5% = مركز مختلف فعلاً)
  لا فقط رمز+اتجاه — يكشف حالات تصفية-ثم-إعادة-فتح الصامتة
- cron-job.org يستدعي /api/alerts كل دقيقتين (يشمل فحص المتداولين + العملات معاً)

## جداول Supabase (خمسة)

```sql
create table watchlist (id bigserial primary key, device_key text not null,
  trader_id text not null, nickname text, added_at timestamptz default now(),
  unique(device_key, trader_id));

create table journal (id bigserial primary key, device_key text not null,
  symbol text not null, side text not null, entry numeric, stop numeric,
  target numeric, size numeric, reason text, exit_price numeric,
  result_note text, opened_at timestamptz default now(), closed_at timestamptz);

create table position_snapshots (device_key text not null, trader_id text not null,
  positions jsonb default '[]', updated_at timestamptz default now(),
  primary key(device_key, trader_id));

create table alert_cursor (device_key text primary key, pos integer default 0,
  updated_at timestamptz default now());

create table watched_coins (device_key text not null, symbol text not null,
  added_at timestamptz default now(), primary key(device_key, symbol));

create table coin_snapshots (device_key text not null, symbol text not null,
  at_low boolean default false, low_price numeric,
  updated_at timestamptz default now(), primary key(device_key, symbol));
```

كلها مع: alter table X enable row level security;

## متغيرات Vercel (أربعة)
SUPABASE_URL, SUPABASE_KEY (مفتاح secret_ الجديد، لا anon)
TELEGRAM_TOKEN, TELEGRAM_CHAT_ID (رقم مجموعة يبدأ بسالب -100...)
⚠️ أي تعديل يتطلب Redeploy فعلي (commit جديد، لا زر Redeploy فقط)

## الصيانة
عند توقف البيانات: /api/debug (أو أنشئ ملف probe مؤقت بنفس أسلوب اليوم)
يكشف مسار باينس الفاشل، حدّث ENDPOINTS في lib/binance.js

## السياق الشخصي
مستخدم مبتدئ في التداول، يعمل الآن عبر Claude Code على حاسوب (كان جوالاً فقط).
اتُّفق على: مراقبة شهر بلا مال حقيقي، ثم فوري لا عقود آجلة.
رُفض بناء أي نظام توصيات (دخول/خروج/أهداف) — التحليل الفني يصف الماضي لا يتنبأ.
رُفض طلب بوت تنفيذ آلي بمال حقيقي حتى اختبار كافٍ على Binance Testnet أولاً.
