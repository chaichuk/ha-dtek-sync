import { chromium } from 'playwright';
import { fetch } from 'undici';

const { CF_WORKER_URL, CF_SECRET_TOKEN } = process.env;
const SHUTDOWNS_PAGE = "https://www.dtek-krem.com.ua/ua/shutdowns";

// Мапа статусів: [перші 30 хв, другі 30 хв]
// 0 = Світло є (Білий)
// 1 = Можливо немає (Сірий)
// 2 = Немає (Чорний)
const STATUS_MAP = {
    "yes": [0, 0],      
    "no": [2, 2],       
    "maybe": [1, 1],    
    "first": [2, 0],    // Немає перші 30 хв
    "second": [0, 2],   // Немає другі 30 хв
    "mfirst": [1, 0],   
    "msecond": [0, 1]   
};

async function run() {
    if (!CF_WORKER_URL || !CF_SECRET_TOKEN) {
        console.error('❌ Помилка: Не задані CF_WORKER_URL або CF_SECRET_TOKEN');
        process.exit(1);
    }

    console.log('🚀 Запуск...');
    const browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    try {
        const page = await browser.newPage();
        
        console.log('🌍 Відкриваю сайт...');
        // Чекаємо завантаження контенту (HTML)
        await page.goto(SHUTDOWNS_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });

        // Отримуємо повний HTML сторінки
        const content = await page.content();
        
        // --- ЛОГІКА ПАРСИНГУ HTML (REGEX) ---
        console.log('🔍 Шукаю дані в коді сторінки...');
        
        // Шукаємо рядок: DisconSchedule.fact = { ... }
        // Регулярка захоплює все від початку об'єкта до його кінця (приблизно)
        const regex = /DisconSchedule\.fact\s*=\s*(\{[\s\S]*?\})\n/m;
        const match = content.match(regex);

        let rawData = null;

        if (match && match[1]) {
            try {
                // Спробуємо розпарсити знайдений текст як JSON
                // Оскільки це JS об'єкт, ключі можуть бути без лапок, але в вашому файлі вони в лапках,
                // тому JSON.parse має спрацювати, якщо структура чиста.
                // Якщо ні - використаємо eval (безпечно в цьому контексті, бо ми самі запускаємо скрипт)
                const jsonStr = match[1];
                
                // Трюк: eval дозволяє прочитати JS-об'єкт, навіть якщо це не строгий JSON
                rawData = eval(`(${jsonStr})`); 
                
                // Нам потрібне поле .data
                rawData = rawData.data;
                
                console.log('✅ Дані успішно вирізано з HTML!');
            } catch (e) {
                console.error('❌ Помилка парсингу знайденого тексту:', e);
            }
        } else {
            console.error('❌ Рядок DisconSchedule.fact не знайдено в HTML.');
        }

        // Якщо Regex не спрацював, спробуємо старий метод (через window) як запасний
        if (!rawData) {
            console.log('⚠️ Спроба отримати дані через JS-змінну...');
            rawData = await page.evaluate(() => {
                return window.DisconSchedule?.fact?.data || null;
            });
        }

        if (!rawData) {
            console.error('❌ ДАНІ НЕ ЗНАЙДЕНО ЖОДНИМ МЕТОДОМ.');
            process.exit(1);
        }

        // --- ОБРОБКА ДАНИХ ---
        console.log('⚙️ Обробка графіків...');
        const formattedSchedule = {};
        const timestamps = Object.keys(rawData).sort();

        const tsToDate = (ts) => {
            const d = new Date(parseInt(ts) * 1000);
            return d.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
        };

        let dateToday = "";
        let dateTomorrow = "";
        
        if (timestamps.length > 0) dateToday = tsToDate(timestamps[0]);
        if (timestamps.length > 1) dateTomorrow = tsToDate(timestamps[1]);

        console.log(`📅 Дати: ${dateToday}, ${dateTomorrow}`);

        for (const ts of timestamps) {
            const dateStr = tsToDate(ts);
            const dayGroups = rawData[ts]; 

            for (const [groupCode, hoursData] of Object.entries(dayGroups)) {
                // "GPV1.1" -> "1.1"
                const cleanGroup = groupCode.replace('GPV', '');
                
                if (!formattedSchedule[cleanGroup]) {
                    formattedSchedule[cleanGroup] = {};
                }
                
                const daySchedule = {};

                // Проходимо по годинах (1..24)
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

        // --- ВІДПРАВКА ---
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

        console.log('📤 Відправка на Worker...');
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
