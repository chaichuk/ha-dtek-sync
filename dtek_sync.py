import requests
import json
import os
from datetime import datetime, timedelta
from dtek_monitor import DtekMonitor 

# НАЛАШТУВАННЯ
# Дані беруться зі змінних оточення (Secrets у GitHub Actions)
CF_WORKER_URL = os.getenv("CF_WORKER_URL")
CF_SECRET_TOKEN = os.getenv("CF_SECRET_TOKEN")

def get_dtek_schedule():
    # Ініціалізація монітора для Київської області ('koe')
    # Якщо потрібно для міста Київ, змініть на 'dtek_kyiv_grids'
    monitor = DtekMonitor(provider='koe') 
    
    try:
        data = monitor.get_schedule()
    except Exception as e:
        print(f"Помилка отримання даних від ДТЕК: {e}")
        return None

    today = datetime.now().strftime("%Y-%m-%d")
    tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")

    formatted_schedule = {}
    for i in range(1, 7):
        formatted_schedule[f"{i}.1"] = {today: {}, tomorrow: {}}
        formatted_schedule[f"{i}.2"] = {today: {}, tomorrow: {}}

    def get_status_code(outage_type):
        if outage_type == 'definitive_outage': return 2 
        if outage_type == 'possible_outage': return 1
        return 0 

    if data:
        for group_num, outages in data.items():
            if not outages: continue
            group_str = str(group_num)
            for outage in outages:
                start = outage['start']
                end = outage['end']
                status = get_status_code(outage['type'])
                current_time = start
                
                while current_time < end:
                    date_str = current_time.strftime("%Y-%m-%d")
                    for sub in ["1", "2"]:
                        key = f"{group_str}.{sub}"
                        if key in formatted_schedule and date_str in formatted_schedule[key]:
                            minute = current_time.minute
                            if minute < 30:
                                time_slot = current_time.replace(minute=0, second=0).strftime("%H:%M")
                            else:
                                time_slot = current_time.replace(minute=30, second=0).strftime("%H:%M")
                            formatted_schedule[key][date_str][time_slot] = status
                    current_time += timedelta(minutes=30)

    time_slots = []
    for h in range(24):
        time_slots.append(f"{h:02d}:00")
        time_slots.append(f"{h:02d}:30")

    for group_key, dates in formatted_schedule.items():
        for date_key, hours in dates.items():
            for slot in time_slots:
                if slot not in hours:
                    formatted_schedule[group_key][date_key][slot] = 0 

    inner_data = {
        "date_today": today,
        "date_tomorrow": tomorrow,
        "regions": [
            {
                "cpu": "kiivska-oblast",
                "name_ua": "Київська",
                "name_ru": "Киевская",
                "name_en": "Kyiv",
                "schedule": formatted_schedule
            }
        ]
    }
    
    final_payload = {
        "body": json.dumps(inner_data, ensure_ascii=False),
        "timestamp": int(datetime.now().timestamp() * 1000)
    }
    
    return final_payload

def send_to_worker(payload):
    if not CF_WORKER_URL or not CF_SECRET_TOKEN:
        print("ПОМИЛКА: Не задані змінні оточення CF_WORKER_URL або CF_SECRET_TOKEN")
        return

    headers = {
        "Authorization": f"Bearer {CF_SECRET_TOKEN}",
        "Content-Type": "application/json"
    }
    try:
        print(f"Відправка даних на {CF_WORKER_URL}...")
        resp = requests.post(CF_WORKER_URL, json=payload, headers=headers)
        if resp.status_code == 200:
            print("✅ Успішно оновлено дані в Cloudflare Worker.")
        else:
            print(f"❌ Помилка оновлення: {resp.status_code} {resp.text}")
    except Exception as e:
        print(f"❌ Помилка з'єднання: {e}")

if __name__ == "__main__":
    print("Початок роботи парсера...")
    payload = get_dtek_schedule()
    if payload:
        send_to_worker(payload)
    else:
        print("Не вдалося отримати графік.")
