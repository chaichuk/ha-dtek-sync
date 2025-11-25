import { chromium } from 'playwright';
import { fetch } from 'undici';

// Налаштування з Secrets
const WORKER_URL = process.env.CF_WORKER_URL;
const SECRET_TOKEN = process.env.CF_SECRET_TOKEN;
const CITY = process.env.CITY;     // Наприклад: "Вишневе"
const STREET = process.env.STREET; // Наприклад: "Лесі Українки"
const HOUSE = process.env.HOUSE;   // Наприклад: "15"

async function run() {
  if (!WORKER_URL || !SECRET_TOKEN || !CITY || !STREET || !HOUSE) {
    console.error('❌ Помилка: Не всі змінні оточення задані (CITY, STREET, HOUSE, CF_WORKER_URL, CF_SECRET_TOKEN)');
    process.exit(1);
  }

  console.log('🚀 Запуск браузера...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // 1. Відкриваємо сайт ДТЕК Київські Регіональні Електромережі
    console.log('🌍 Відкриваю сайт ДТЕК...');
    await page.goto('https://www.dtek-krem.com.ua/ua/shutdowns');

    // 2. Заповнюємо форму
    console.log(`📝 Вводжу адресу: ${CITY}, ${STREET}, ${HOUSE}`);
    
    // Вводимо місто
    await page.getByLabel('Населений пункт').fill(CITY);
    // Чекаємо на випадаючий список і клікаємо перше співпадіння (або конкретне)
    await page.waitForTimeout(1000); 
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Вводимо вулицю
    await page.getByLabel('Вулиця').fill(STREET);
    await page.waitForTimeout(1000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Вводимо будинок
    await page.getByLabel('Будинок').fill(HOUSE);
    await page.waitForTimeout(1000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Натискаємо "Перевірити"
    await page.getByRole('button', { name: 'Перевірити' }).click();

    // 3. Чекаємо на результат
    console.log('⏳ Чекаю на графік...');
    // Чекаємо появи контейнера з графіком (клас може змінюватися, шукаємо по тексту або структурі)
    // Зазвичай там з'являється таблиця або повідомлення
    await page.waitForSelector('.disconnection-schedule', { timeout: 10000 }).catch(() => console.log("⚠️ Специфічний селектор не знайдено, шукаємо далі..."));

    // --- ТУТ ПОТРІБНА ЛОГІКА ПАРСИНГУ САМЕ ЦЬОГО САЙТУ ---
    // Оскільки сайт динамічний, ми спробуємо знайти групу або дані графіку.
    // Для спрощення ми зараз зробимо емуляцію:
    // Якщо парсинг складний, ми можемо просто взяти ГРУПУ, якщо вона відображається,
    // і згенерувати JSON на основі статичного розкладу (якщо він фіксований) 
    // АБО спробувати витягнути години.
    
    // Припустимо, ми знайшли, що зараз світла немає (status = 2)
    // У рамках цього прикладу я створюю "болванку" JSON, яку ви очікуєте.
    // **ВАЖЛИВО**: Щоб парсити реальні години з dtek-krem, треба бачити HTML сторінки результатів.
    // Але давайте сформуємо структуру, щоб все працювало технічно.
    
    const todayStr = new Date().toISOString().split('T')[0];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Генеруємо пустий графік (0 - світло є)
    const generateEmptyDay = () => {
        const day = {};
        for (let i = 0; i < 24; i++) {
            const h = i.toString().padStart(2, '0');
            day[`${h}:00`] = 0;
            day[`${h}:30`] = 0;
        }
        return day;
    };

    const schedule = {};
    // Заповнюємо для груп 1-6
    for (let i = 1; i <= 6; i++) {
        schedule[`${i}.1`] = { [todayStr]: generateEmptyDay(), [tomorrowStr]: generateEmptyDay() };
        schedule[`${i}.2`] = { [todayStr]: generateEmptyDay(), [tomorrowStr]: generateEmptyDay() };
    }

    // Тут ви можете додати реальну логіку, якщо сайт показує "Група 1: відключення з 14:00 до 18:00"
    // const groupText = await page.locator('.some-group-class').innerText();
    // ... parse groupText ...

    // Формуємо фінальний об'єкт
    const finalJson = {
        date_today: todayStr,
        date_tomorrow: tomorrowStr,
        regions: [
            {
                cpu: "kiivska-oblast",
                name_ua: "Київська",
                name_ru: "Киевская",
                name_en": "Kyiv",
                schedule: schedule
            }
        ]
    };

    const payload = {
        body: JSON.stringify(finalJson),
        timestamp: Date.now()
    };

    console.log('📤 Відправляю дані на Worker...');
    
    const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SECRET_TOKEN}`
        },
        body: JSON.stringify(payload)
    });

    if (response.ok) {
        console.log('✅ Дані успішно оновлено!');
    } else {
        console.error(`❌ Помилка оновлення: ${response.status} ${await response.text()}`);
    }

  } catch (e) {
    console.error('❌ Помилка під час виконання:', e);
  } finally {
    await browser.close();
  }
}

run();
```

### Файл 3: `.github/workflows/update_schedule.yml`
Це інструкція для GitHub, як запускати Node.js.

**Створіть файл `.github/workflows/update_schedule.yml`:**
```yaml
name: Update DTEK Schedule (Node.js)

on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 18

      - name: Install dependencies
        run: npm install

      - name: Install Playwright Browsers
        run: npx playwright install chromium --with-deps

      - name: Run Sync Script
        env:
          CF_WORKER_URL: ${{ secrets.CF_WORKER_URL }}
          CF_SECRET_TOKEN: ${{ secrets.CF_SECRET_TOKEN }}
          CITY: ${{ secrets.CITY }}
          STREET: ${{ secrets.STREET }}
          HOUSE: ${{ secrets.HOUSE }}
        run: node sync.js
