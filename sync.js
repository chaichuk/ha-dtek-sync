import { chromium } from 'playwright';
import { fetch } from 'undici';

const { CF_WORKER_URL, CF_SECRET_TOKEN, CITY, STREET, HOUSE } = process.env;
const SHUTDOWNS_PAGE = "https://www.dtek-krem.com.ua/ua/shutdowns";

// 🔥 ТЕСТОВИЙ РЕЖИМ: ОДНА АДРЕСА 🔥
// Ми використовуємо вашу адресу з налаштувань GitHub.
// Скрипт вважатиме, що це "Група 1" (але запише ці дані у всі групи для надійності).
const MONITOR_TARGETS = [
    { group: 1, city: CITY, street: STREET, house: HOUSE }
];

// Функція для правильного форматування дати (DD.MM.YYYY HH:mm)
// Це критично важливо, бо сервери GitHub дають американський формат, який ДТЕК відхиляє ("Error")
function getDtekDateString() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
    // Форматуємо частинами, щоб гарантувати порядок DD.MM.YYYY
    const parts = formatter.formatToParts(now);
    const getPart = (type) => parts.find(p => p.type === type).value;
    return `${getPart('day')}.${getPart('month')}.${getPart('year')} ${getPart('hour')}:${getPart('minute')}`;
}

async function getScheduleForAddress(page, target) {
    console.log(`🔎 Перевірка адреси: ${target.city}, ${target.street}, ${target.house}`);
    
    try {
        // Отримуємо токен безпеки
        const csrfToken = await page.locator('meta[name="csrf-token"]').getAttribute("content");
        const updateFactDate = getDtekDateString(); // Використовуємо нашу правильну дату

        // Виконуємо запит прямо з браузера
        const info = await page.evaluate(async ({ city, street, house, token, dateStr }) => {
            const formData = new URLSearchParams();
            formData.append("method", "getHomeNum");
            formData.append("data[0][name]", "city");
            formData.append("data[0][value]", city);
            formData.append("data[1][name]", "street");
            formData.append("data[1][value]", street);
            formData.append("data[2][name]", "updateFact");
            formData.append("data[2][value]", dateStr); 

            try {
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
            } catch (e) {
                return { error: e.toString() };
            }
        }, { 
            city: target.city, 
            street: target.street, 
            house: target.house, 
            token: csrfToken, 
            dateStr: updateFactDate 
        });

        // Перевірка на помилки
        if (!info) return null;
        if (info.result === false) {
            console.error(`❌ ДТЕК відхилив запит (Error):`, info.text);
            return null;
        }

        // Шукаємо наш будинок у відповіді
        const houseData = info.data?.[target.house];
        if (!houseData) {
            console.warn(`⚠️ Дані отримано, але для будинку "${target.house}" інформації немає.`);
            console.log(`Доступні будинки на цій вулиці: ${Object.keys(info.data || {}).join(', ')}`);
            return null;
        }

        return houseData;

    } catch (e) {
        console.error(`❌ Помилка парсингу:`, e);
        return null;
    }
}

async function run() {
    if (!CF_WORKER_URL || !CF_SECRET_TOKEN || !CITY) {
        console.error('❌ Помилка: Немає Secret змінних (CF_WORKER_URL, CITY тощо)!');
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Підготовка пустого графіку
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

    const generateEmptyDay = () => {
        const day = {};
        for (let i = 0; i < 24; i++) {
            const h = i.toString().padStart(2, '0');
            day[`${h}:00`] = 0; // 0 = Світло є
            day[`${h}:30`] = 0;
        }
        return day;
    };

    // Створюємо структуру для результату
    // Використовуємо один спільний графік для всіх груп (поки що)
    const commonSchedule = { 
        [todayStr]: generateEmptyDay(), 
        [tomorrowStr]: generateEmptyDay() 
    };

    try {
        console.log('🌍 Відкриваю сайт ДТЕК...');
        await page.goto(SHUTDOWNS_PAGE, { waitUntil: "load" });

        // Опитуємо (в даному випадку одну) адресу
        for (const target of MONITOR_TARGETS) {
            const data = await getScheduleForAddress(page, target);
            
            if (data && (data.sub_type || data.type)) {
                console.log(`🚨 ЗНАЙДЕНО ВІДКЛЮЧЕННЯ: ${data.start_date} - ${data.end_date}`);
                console.log(`Тип: ${data.sub_type}`);
                
                // Парсинг дат
                const parseDtekDate = (dateStr) => {
                    if (!dateStr) return null;
                    const [datePart, timePart] = dateStr.split(' ');
                    const [d, m, y] = datePart.split('.');
                    const [h, min] = timePart.split(':');
                    return new Date(`${y}-${m}-${d}T${h}:${min}:00`);
                };

                const start = parseDtekDate(data.start_date);
                const end = parseDtekDate(data.end_date);

                if (start && end) {
                    let current = new Date(start);
                    // Округлення до 30 хв
                    current.setSeconds(0, 0);
                    if (current.getMinutes() > 0 && current.getMinutes() < 30) current.setMinutes(0);
                    if (current.getMinutes() > 30) current.setMinutes(30);

                    while (current < end) {
                        const dStr = current.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
                        const hStr = current.toLocaleTimeString("en-GB", { timeZone: "Europe/Kyiv", hour: '2-digit', minute: '2-digit' });
                        
                        if (commonSchedule[dStr] && commonSchedule[dStr][hStr] !== undefined) {
                            commonSchedule[dStr][hStr] = 2; // 2 = Відключення (Чорне)
                        }
                        
                        current.setMinutes(current.getMinutes() + 30);
                    }
                }
            } else {
                console.log(`⚡️ За вашою адресою відключень наразі не зафіксовано.`);
            }
            
            await page.waitForTimeout(1000);
        }

        // Розмножуємо цей графік на всі 6 груп для JSON
        const finalSchedule = {};
        for (let i = 1; i <= 6; i++) {
            // Використовуємо structuredClone, щоб копіювати об'єкт, а не посилання
            finalSchedule[`${i}.1`] = JSON.parse(JSON.stringify(commonSchedule));
            finalSchedule[`${i}.2`] = JSON.parse(JSON.stringify(commonSchedule));
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
                    schedule: finalSchedule
                }
            ]
        };

        const payload = {
            body: JSON.stringify(finalJson),
            timestamp: Date.now()
        };

        console.log('📤 Відправляю дані на Worker...');
        const response = await fetch(CF_WORKER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CF_SECRET_TOKEN}`
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log('✅ Успіх! Графік оновлено.');
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
