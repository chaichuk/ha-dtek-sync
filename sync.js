import { chromium } from 'playwright';
import { fetch } from 'undici';

const { CF_WORKER_URL, CF_SECRET_TOKEN, CITY, STREET, HOUSE } = process.env;
const SHUTDOWNS_PAGE = "https://www.dtek-krem.com.ua/ua/shutdowns";

async function run() {
  if (!CF_WORKER_URL || !CF_SECRET_TOKEN || !CITY || !STREET || !HOUSE) {
    console.error('❌ Помилка: Немає Secret змінних!');
    process.exit(1);
  }

  console.log(`🚀 Перевіряємо адресу: ${CITY}, ${STREET}, ${HOUSE}`);
  const browser = await chromium.launch({ headless: true });
  
  try {
    const page = await browser.newPage();
    await page.goto(SHUTDOWNS_PAGE, { waitUntil: "load" });

    // Отримуємо токен
    const csrfToken = await page.locator('meta[name="csrf-token"]').getAttribute("content");
    
    // Робимо запит до ДТЕК
    const info = await page.evaluate(async ({ city, street, token }) => {
        const formData = new URLSearchParams();
        formData.append("method", "getHomeNum");
        formData.append("data[0][name]", "city");
        formData.append("data[0][value]", city);
        formData.append("data[1][name]", "street");
        formData.append("data[1][value]", street);
        formData.append("data[2][name]", "updateFact");
        formData.append("data[2][value]", new Date().toLocaleString("uk-UA")); // Це може впливати!

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

    // 🔥🔥🔥 НАЙВАЖЛИВІШЕ ДЛЯ ДЕБАГУ 🔥🔥🔥
    console.log("\n--- ПОЧАТОК ВІДПОВІДІ ДТЕК ---");
    console.log(JSON.stringify(info, null, 2));
    console.log("--- КІНЕЦЬ ВІДПОВІДІ ДТЕК ---\n");

    const houseData = info?.data?.[HOUSE];

    if (!houseData) {
        console.error(`❌ УВАГА: У відповіді немає даних для будинку "${HOUSE}".`);
        console.error(`Доступні ключі (будинки): ${Object.keys(info?.data || {}).join(', ')}`);
        // Не виходимо, йдемо далі, щоб побачити, що відправиться
    } else {
        console.log("✅ Дані для будинку знайдено:", houseData);
    }

    // ... тут стара логіка формування JSON (вона поки не важлива, нам треба побачити лог вище) ...
    // Я залишаю мінімальну відправку, щоб скрипт не впав
    
    const todayStr = new Date().toISOString().split('T')[0];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Функція для генерації пустих годин
    const generateEmptyDay = () => {
        const day = {};
        for (let i = 0; i < 24; i++) {
            const h = i.toString().padStart(2, '0');
            day[`${h}:00`] = 0;
            day[`${h}:30`] = 0;
        }
        return day;
    }

    // Якщо ми змогли розпарсити дані (спробуємо тут просту логіку)
    const scheduleMap = {
        [todayStr]: generateEmptyDay(),
        [tomorrowStr]: generateEmptyDay()
    };

    // Спроба парсингу
    if (houseData && houseData.start_date) {
        console.log("🛠 Спроба розпарсити дату:", houseData.start_date);
        // Тут може бути проблема з форматом дати, подивимось в логах який він
    }

    // ... відправка поки не критична, головне логи ...

  } catch (err) {
    console.error('❌ Помилка:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
