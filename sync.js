import { chromium } from 'playwright';
import { fetch } from 'undici';

// 1. Налаштування (беруться з Secrets GitHub)
const { 
  CF_WORKER_URL, 
  CF_SECRET_TOKEN, 
  CITY, 
  STREET, 
  HOUSE 
} = process.env;

const SHUTDOWNS_PAGE = "https://www.dtek-krem.com.ua/ua/shutdowns";

async function run() {
  // Перевірка наявності всіх змінних
  if (!CF_WORKER_URL || !CF_SECRET_TOKEN || !CITY || !STREET || !HOUSE) {
    console.error('❌ Помилка: Відсутні необхідні Secrets. Перевірте налаштування репозиторію (CITY, STREET, HOUSE, CF_WORKER_URL, CF_SECRET_TOKEN)');
    process.exit(1);
  }

  console.log(`🚀 Запуск моніторингу для: ${CITY}, ${STREET}, ${HOUSE}`);
  const browser = await chromium.launch({ headless: true });
  
  try {
    const page = await browser.newPage();
    
    // 2. Заходимо на сайт, щоб отримати токен безпеки (CSRF)
    console.log('🌍 Відкриваю сторінку ДТЕК...');
    await page.goto(SHUTDOWNS_PAGE, { waitUntil: "load" });

    // Чекаємо на токен у коді сторінки
    const csrfTokenTag = await page.waitForSelector('meta[name="csrf-token"]', { state: "attached" });
    const csrfToken = await csrfTokenTag.getAttribute("content");
    console.log('🔑 Токен безпеки отримано.');

    // 3. Виконуємо "Хитрий запит" (як у оригінальному парсері)
    // Ми виконуємо код прямо всередині сторінки браузера
    console.log('📡 Отримую дані про відключення...');
    const info = await page.evaluate(async ({ city, street, token }) => {
        const formData = new URLSearchParams();
        formData.append("method", "getHomeNum");
        formData.append("data[0][name]", "city");
        formData.append("data[0][value]", city);
        formData.append("data[1][name]", "street");
        formData.append("data[1][value]", street);
        // Цей параметр вимагає сервер
        formData.append("data[2][name]", "updateFact");
        formData.append("data[2][value]", new Date().toLocaleString("uk-UA"));

        const response = await fetch("/ua/ajax", {
          method: "POST",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "x-csrf-token": token,
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
          },
          body: formData,
        });
        return await response.json();
    }, { city: CITY, street: STREET, token: csrfToken });

    // 4. Обробка результатів
    // info.data - це об'єкт, де ключі - номери будинків
    const houseData = info?.data?.[HOUSE];

    if (!houseData) {
        console.log('⚠️ Даних по вашому будинку в відповіді не знайдено. Можливо, помилка в назві вулиці або будинку.');
        console.log('Доступні будинки на цій вулиці:', Object.keys(info?.data || {}).join(', '));
        // Не виходимо, відправимо "пустий" графік (світло є), щоб не ламати інтеграцію
    }

    // Готуємо графік (0 - світло є, 1 - можливо, 2 - немає)
    // За замовчуванням заповнюємо "світло є"
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" }); // YYYY-MM-DD
    
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

    const generateEmptyDay = () => {
        const day = {};
        for (let i = 0; i < 24; i++) {
            const h = i.toString().padStart(2, '0');
            day[`${h}:00`] = 0;
            day[`${h}:30`] = 0;
        }
        return day;
    };

    const scheduleMap = {
        [todayStr]: generateEmptyDay(),
        [tomorrowStr]: generateEmptyDay()
    };

    // Якщо є відключення, заповнюємо графік
    if (houseData && (houseData.sub_type || houseData.type)) {
        console.log(`🚨 ЗНАЙДЕНО ВІДКЛЮЧЕННЯ: ${houseData.start_date} - ${houseData.end_date} (${houseData.sub_type})`);
        
        // Функція для парсингу дати з рядка ДТЕК (DD.MM.YYYY HH:mm)
        const parseDtekDate = (dateStr) => {
            if (!dateStr) return null;
            const [datePart, timePart] = dateStr.split(' ');
            const [d, m, y] = datePart.split('.');
            const [h, min] = timePart.split(':');
            return new Date(`${y}-${m}-${d}T${h}:${min}:00`);
        };

        const start = parseDtekDate(houseData.start_date);
        const end = parseDtekDate(houseData.end_date);

        if (start && end) {
            let current = new Date(start);
            // Округлюємо до найближчих 30 хв вниз
            current.setSeconds(0, 0);
            if (current.getMinutes() > 0 && current.getMinutes() < 30) current.setMinutes(0);
            if (current.getMinutes() > 30) current.setMinutes(30);

            while (current < end) {
                const dStr = current.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
                const hStr = current.toLocaleTimeString("en-GB", { timeZone: "Europe/Kyiv", hour: '2-digit', minute: '2-digit' });
                
                if (scheduleMap[dStr] && scheduleMap[dStr][hStr] !== undefined) {
                    // Ставимо 2 (відключення)
                    scheduleMap[dStr][hStr] = 2; 
                }
                current.setMinutes(current.getMinutes() + 30);
            }
        }
    } else {
        console.log('⚡️ Активних відключень за вашою адресою не знайдено.');
    }

    // 5. Формуємо JSON для Cloudflare
    // Заповнюємо цим графіком ВСІ групи, щоб в Home Assistant завжди показувало правду
    const schedule = {};
    for (let i = 1; i <= 6; i++) {
        schedule[`${i}.1`] = scheduleMap;
        schedule[`${i}.2`] = scheduleMap;
    }

    const finalJson = {
        date_today: todayStr,
        date_tomorrow: tomorrowStr,
        regions: [
            {
                cpu: "kiivska-oblast",
                name_ua: "Київська",
                name_ru: "Киевская",
                name_en: "Kyiv",
                schedule: schedule 
            }
        ]
    };

    const payload = {
        body: JSON.stringify(finalJson),
        timestamp: Date.now()
    };

    // 6. Відправка на Worker
    console.log('📤 Відправляю дані на Cloudflare Worker...');
    const response = await fetch(CF_WORKER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CF_SECRET_TOKEN}`
        },
        body: JSON.stringify(payload)
    });

    if (response.ok) {
        console.log('✅ Успіх! Дані оновлено.');
    } else {
        console.error(`❌ Помилка відправки: ${response.status} ${await response.text()}`);
    }

  } catch (err) {
    console.error('❌ Критична помилка:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
