import { chromium } from 'playwright';
import { fetch } from 'undici';

const { CF_WORKER_URL, CF_SECRET_TOKEN } = process.env;
const SHUTDOWNS_PAGE = "https://www.dtek-krem.com.ua/ua/shutdowns";

// Статуси: 0=Є, 1=Можливо, 2=Немає
const STATUS_MAP = {
    "yes": [0, 0],      
    "no": [2, 2],       
    "maybe": [1, 1],    
    "first": [2, 0],    
    "second": [0, 2],   
    "mfirst": [1, 0],   
    "msecond": [0, 1]   
};

async function run() {
    if (!CF_WORKER_URL || !CF_SECRET_TOKEN) {
        console.error('❌ Помилка: Не задані CF_WORKER_URL або CF_SECRET_TOKEN');
        process.exit(1);
    }

    console.log('🚀 Запуск глобального парсера (режим Stealth)...');
    
    // Запускаємо браузер з налаштуваннями, щоб сховатися від бот-фільтрів
    const browser = await chromium.launch({ 
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled', // Приховує, що це автоматизація
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });
    
    // Створюємо контекст з реалістичним User-Agent
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    try {
        const page = await context.newPage();
        
        // Додаємо скрипт, щоб приховати webdriver (ще один рівень захисту)
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        console.log('🌍 Відкриваю сайт ДТЕК...');
        // Збільшуємо тайм-аут до 60 секунд на випадок перевірки Cloudflare
        await page.goto(SHUTDOWNS_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });

        console.log('⏳ Чекаю проходження перевірки Cloudflare та завантаження даних...');
        // Чекаємо трохи, щоб Cloudflare встиг подумати, а сайт - ініціалізувати змінні
        await page.waitForTimeout(10000); 

        // Спробуємо знайти дані кілька разів
        let dtekData = null;
        for (let i = 0; i < 5; i++) {
            dtekData = await page.evaluate(() => {
                if (typeof window.DisconSchedule === 'undefined' || !window.DisconSchedule.fact) {
                    return null;
                }
                return window.DisconSchedule.fact.data;
            });

            if (dtekData) break;
            console.log(`...спроба ${i + 1}: даних ще немає, чекаю...`);
            await page.waitForTimeout(3000);
        }

        if (!dtekData) {
            // Якщо даних немає, зробимо скріншот для дебагу (в логах GitHub його не видно, але помилку кинемо)
            console.error('❌ Не вдалося знайти DisconSchedule.fact.data навіть після очікування.');
            // Перевіримо заголовок, може нас заблокували
            const title = await page.title();
            console.log('Заголовок сторінки:', title);
            process.exit(1);
        }

        console.log('✅ Глобальні дані отримано! Починаю обробку...');
        
        const formattedSchedule = {};
        const timestamps = Object.keys(dtekData).sort();
        
        let dateToday = "";
        let dateTomorrow = "";

        const tsToDate = (ts) => {
            const d = new Date(parseInt(ts) * 1000);
            return d.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
        };

        if (timestamps.length > 0) dateToday = tsToDate(timestamps[0]);
        if (timestamps.length > 1) dateTomorrow = tsToDate(timestamps[1]);
        
        console.log(`📅 Знайдено дати: ${dateToday} та ${dateTomorrow}`);

        // Парсинг даних
        for (const ts of timestamps) {
            const dateStr = tsToDate(ts);
            const dayData = dtekData[ts]; 

            for (const [groupKey, hoursData] of Object.entries(dayData)) {
                // "GPV1.1" -> "1.1"
                const cleanGroup = groupKey.replace('GPV', '');
                
                if (!formattedSchedule[cleanGroup]) {
                    formattedSchedule[cleanGroup] = {};
                }
                
                const daySchedule = {};

                for (let h = 1; h <= 24; h++) {
                    const statusKey = hoursData[h.toString()];
                    const codes = STATUS_MAP[statusKey] || [0, 0];

                    const hourIndex = h - 1; 
                    const hh = hourIndex.toString().padStart(2, '0');

                    daySchedule[`${hh}:00`] = codes[0];
                    daySchedule[`${hh}:30`] = codes[1];
                }

                formattedSchedule[cleanGroup][dateStr] = daySchedule;
            }
        }

        // Перевірка, чи сформувалися дані
        if (Object.keys(formattedSchedule).length === 0) {
            console.error("❌ Помилка: JSON пустий після парсингу.");
            process.exit(1);
        }

        const finalJson = {
            date_today: dateToday,
            date_tomorrow: dateTomorrow,
            regions: [
                {
                    cpu: "kiivska-oblast",
                    name_ua: "Київська",
                    name_ru: "Киевская",
                    name_en: "Kyiv",
                    schedule: formattedSchedule
                }
            ]
        };

        console.log('📤 Відправляю дані на Worker...');
        const response = await fetch(CF_WORKER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CF_SECRET_TOKEN}`
            },
            body: JSON.stringify({
                body: JSON.stringify(finalJson),
                timestamp: Date.now()
            })
        });

        if (response.ok) {
            console.log('✅ Успіх! Дані оновлено.');
        } else {
            console.error(`❌ Помилка Worker: ${response.status} ${await response.text()}`);
        }

    } catch (err) {
        console.error('❌ Критична помилка:', err);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

run();
