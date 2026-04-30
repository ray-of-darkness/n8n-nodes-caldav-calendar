import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	NodeConnectionType,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ICredentialDataDecryptedObject,
} from 'n8n-workflow';

import * as dav from 'dav';

/**
 * Enum для частот повторения событий в RRULE
 */
enum RecurrenceFrequency {
	DAILY = 'DAILY',
	WEEKLY = 'WEEKLY',
	MONTHLY = 'MONTHLY',
	YEARLY = 'YEARLY'
}

/**
 * Структура объекта календаря DAV
 */
interface CalendarObject {
	url: string;
	displayName?: string;
	name?: string;
	description?: string;
	componentSet?: string[];
}

/**
 * Calendar with URL and objects
 */
interface Calendar {
	url: string;
	objects?: CalendarObject[];
}

/**
 * Calendar event with support for various date formats
 */
interface CalendarEvent {
	summary?: string;
	start?: Date | string; // iCal может содержать строки дат
	end?: Date | string;   // iCal может содержать строки дат
	description?: string;
	location?: string;
	uid?: string;
	url?: string;
	etag?: string;
	calendarData?: string;
}

/**
 * Структура парсинга iCal даты
 */
interface ParsedICalDate {
	date: Date;
	timezone?: string;
	isUtc: boolean;
	originalString: string;
}

/**
 * Sample event for debugging and calendar data analysis
 */
interface SampleEvent {
	error?: string;
	objectIndex?: number;
	totalVEventBlocks?: number;
	firstVEventPreview?: string;
	calendarDataStart?: string;
	eventIndex?: number;
	dtStart?: string;
	summary?: string;
	eventDataPreview?: string;
}

export class Caldav implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CalDAV',
		name: 'caldav',
		icon: 'file:caldav.svg',
		group: ['transform'],
		version: 2,
		subtitle: '={{$parameter["operation"]}}',
		description: '={{$parameter["operation"] === "getEvents" ? ("Get events from " + ($parameter["calendarUrl"] ? $parameter["calendarUrl"] : "selected calendar")) : $parameter["operation"] === "createEvent" ? ("Create event in " + ($parameter["calendarUrl"] ? $parameter["calendarUrl"] : "selected calendar")) : $parameter["operation"] === "deleteEvent" ? ("Delete event from " + ($parameter["calendarUrl"] ? $parameter["calendarUrl"] : "selected calendar")) : "Interact with CalDAV calendars"}}',
		usableAsTool: true,
		defaults: {
			name: 'CalDAV',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'caldavApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getEvents',
				options: [
					{
						name: 'Get Events',
						value: 'getEvents',
						description: 'Get calendar events for a specific date',
						action: 'Get events',
					},
					{
						name: 'Create Event',
						value: 'createEvent',
						description: 'Create a new calendar event',
						action: 'Create event',
					},
					{
						name: 'Delete Event',
						value: 'deleteEvent',
						description: 'Delete an existing calendar event',
						action: 'Delete event',
					},
				],
			},
			{
				displayName: 'Calendar Name or ID',
				name: 'calendarUrl',
				type: 'options',
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: {
					loadOptionsMethod: 'getCalendars',
				},
				displayOptions: {
					show: {
						operation: ['getEvents'],
					},
				},
			},
			{
				displayName: 'Date',
				name: 'date',
				type: 'dateTime',
				default: '',
				description: 'Date to get events for',
				displayOptions: {
					show: {
						operation: ['getEvents'],
					},
				},
			},
			// Parameters for creating event
			{
				displayName: 'Calendar Name or ID',
				name: 'calendarUrl',
				type: 'options',
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: {
					loadOptionsMethod: 'getCalendars',
				},
				displayOptions: {
					show: {
						operation: ['createEvent'],
					},
				},
			},
			{
				displayName: 'Event Title',
				name: 'eventTitle',
				type: 'string',
				default: '',
				description: 'Title/summary of the event',
				required: true,
				displayOptions: {
					show: {
						operation: ['createEvent'],
					},
				},
			},
			{
				displayName: 'Start Date and Time',
				name: 'startDateTime',
				type: 'dateTime',
				default: '',
				description: 'Start date and time of the event',
				required: true,
				displayOptions: {
					show: {
						operation: ['createEvent'],
					},
				},
			},
			{
				displayName: 'End Date and Time',
				name: 'endDateTime',
				type: 'dateTime',
				default: '',
				description: 'End date and time of the event',
				required: true,
				displayOptions: {
					show: {
						operation: ['createEvent'],
					},
				},
			},
			{
				displayName: 'Description',
				name: 'eventDescription',
				type: 'string',
				default: '',
				description: 'Description of the event',
				displayOptions: {
					show: {
						operation: ['createEvent'],
					},
				},
			},
			{
				displayName: 'Location',
				name: 'eventLocation',
				type: 'string',
				default: '',
				description: 'Location of the event',
				displayOptions: {
					show: {
						operation: ['createEvent'],
					},
				},
			},

			// Parameters for deleting event
			{
				displayName: 'Calendar Name or ID',
				name: 'calendarUrl',
				type: 'options',
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: {
					loadOptionsMethod: 'getCalendars',
				},
				displayOptions: {
					show: {
						operation: ['deleteEvent'],
					},
				},
			},
			{
				displayName: 'Event UID',
				name: 'eventUID',
				type: 'string',
				default: '',
				description: 'Unique identifier of the event to delete',
				required: true,
				displayOptions: {
					show: {
						operation: ['deleteEvent'],
					},
				},
			},
		],
	};

	methods = {
		loadOptions: {
			async getCalendars(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const credentials = await this.getCredentials('caldavApi');

					// Создаем транспорт для аутентификации
					const xhr = new dav.transport.Basic(
						new dav.Credentials({
							username: credentials.username as string,
							password: credentials.password as string,
						})
					);

					// Создаем аккаунт CalDAV и загружаем календари
					const account = await dav.createAccount({
						server: credentials.serverUrl as string,
						xhr: xhr,
						accountType: 'caldav',
						loadCollections: true,
						loadObjects: false,
					});

					// Преобразуем календари в опции для выпадающего списка
					const calendarOptions: INodePropertyOptions[] = [];

					for (const calendar of account.calendars) {
						// Извлекаем относительный путь календаря (убираем serverUrl)
						const serverUrl = credentials.serverUrl as string;
						let calendarPath = calendar.url;
						
						if (calendarPath.startsWith(serverUrl)) {
							calendarPath = calendarPath.substring(serverUrl.length);
						}
						
						// Если путь не начинается с /, добавляем его
						if (!calendarPath.startsWith('/')) {
							calendarPath = '/' + calendarPath;
						}

						// Пытаемся получить красивое название календаря
						let calendarName = '';
						
						// Проверяем доступные свойства календаря для названия
						if ((calendar as CalendarObject).displayName) {
							calendarName = (calendar as CalendarObject).displayName!;
						} else if ((calendar as CalendarObject).name) {
							calendarName = (calendar as CalendarObject).name!;
						} else if ((calendar as CalendarObject).description) {
							calendarName = (calendar as CalendarObject).description!;
						} else {
							// Fallback: извлекаем название из URL (последняя часть пути)
							const pathParts = calendarPath.split('/').filter(part => part.length > 0);
							calendarName = pathParts[pathParts.length - 1] || calendarPath;
							
							// Убираем trailing slash если есть
							if (calendarName.endsWith('/')) {
								calendarName = calendarName.slice(0, -1);
							}
						}

						// Check calendar type by URL and properties
						let calendarType = 'Calendar';
						if (calendarPath.includes('events') || (calendar as CalendarObject).componentSet?.includes('VEVENT')) {
							calendarType = 'Events';
						} else if (calendarPath.includes('todos') || calendarPath.includes('tasks') || (calendar as CalendarObject).componentSet?.includes('VTODO')) {
							calendarType = 'Tasks';
						}

						// Формируем финальное название
						const displayName = calendarName ? `${calendarName} (${calendarType})` : `${calendarType} - ${calendarPath}`;

						calendarOptions.push({
							name: displayName,
							value: calendarPath,
							description: `Путь: ${calendarPath}${(calendar as CalendarObject).description ? ` | ${(calendar as CalendarObject).description}` : ''}`,
						});
					}

					// Сортируем календари по названию
					calendarOptions.sort((a, b) => a.name.localeCompare(b.name));

					return calendarOptions;

				} catch (error) {
					// Return error stub for debugging
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					return [
						{
							name: 'Calendar loading error',
							value: '/calendars/error',
							description: `Error: ${errorMessage}`,
						},
					];
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		const credentials = await this.getCredentials('caldavApi');

		// Function for generating unique event UID
		const generateEventUID = (): string => {
			return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@n8n.io`;
		};

		// Function for formatting date to iCal format
		const formatDateForICal = (date: Date, isAllDay = false): string => {
			if (isAllDay) {
				return date.toISOString().split('T')[0].replace(/-/g, '');
			}
			return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
		};

		// Function for generating iCal event
		const generateICalEvent = (eventData: {
			uid?: string;
			title: string;
			startDateTime: Date;
			endDateTime: Date;
			description?: string;
			location?: string;
		}): string => {
			const uid = eventData.uid || generateEventUID();
			const now = new Date();
			const timestamp = formatDateForICal(now);
			
			let ical = 'BEGIN:VCALENDAR\r\n';
			ical += 'VERSION:2.0\r\n';
			ical += 'PRODID:-//n8n//CalDAV Node//EN\r\n';
			ical += 'BEGIN:VEVENT\r\n';
			ical += `UID:${uid}\r\n`;
			ical += `DTSTAMP:${timestamp}\r\n`;
			ical += `DTSTART:${formatDateForICal(eventData.startDateTime)}\r\n`;
			ical += `DTEND:${formatDateForICal(eventData.endDateTime)}\r\n`;
			ical += `SUMMARY:${eventData.title}\r\n`;
			
			if (eventData.description) {
				ical += `DESCRIPTION:${eventData.description.replace(/\n/g, '\\n')}\r\n`;
			}
			
			if (eventData.location) {
				ical += `LOCATION:${eventData.location}\r\n`;
			}
			
			ical += 'END:VEVENT\r\n';
			ical += 'END:VCALENDAR\r\n';
			
			return ical;
		};

		// Функция для поиска события по имени файла (альтернативный метод)
		const findEventByFilename = async (calendarUrl: string, uid: string, xhr: dav.transport.Basic) => {
			try {
				// Создаем аккаунт CalDAV
				const account = await dav.createAccount({
					server: credentials.serverUrl as string,
					xhr: xhr,
					accountType: 'caldav',
					loadCollections: true,
					loadObjects: false,
				});

				// Находим нужный календарь
				const fullCalendarUrl = `${credentials.serverUrl}${calendarUrl}`;
				const calendar = account.calendars.find((cal: Calendar) => 
					cal.url === fullCalendarUrl || cal.url.endsWith(calendarUrl)
				);

				if (!calendar) {
					return null;
				}

				// Формируем ожидаемый URL события
				let expectedEventUrl = calendar.url;
				if (!expectedEventUrl.endsWith('/')) {
					expectedEventUrl += '/';
				}
				expectedEventUrl += `${uid}.ics`;

				// Пытаемся загрузить событие напрямую по URL
				try {
					const directRequest = {
						method: 'GET',
						requestData: '',
						transformRequest: (data: unknown) => data,
						transformResponse: (data: unknown) => data,
					};
					
					const response = await xhr.send(directRequest, expectedEventUrl, {});
					
					if (response && response.responseText) {
						return {
							url: expectedEventUrl,
							etag: response.xhr?.getResponseHeader?.('etag') || '',
							calendarData: response.responseText,
						};
					}
				} catch (directError) {
					// Если прямой запрос не работает, возвращаем null
					return null;
				}

				return null;
			} catch (error) {
				return null;
			}
		};

		// Функция для поиска события по UID в календаре
		const findEventByUID = async (calendarUrl: string, uid: string, xhr: dav.transport.Basic) => {
			try {
				// Создаем аккаунт CalDAV
				const account = await dav.createAccount({
					server: credentials.serverUrl as string,
					xhr: xhr,
					accountType: 'caldav',
					loadCollections: true,
					loadObjects: false,
				});

				// Находим нужный календарь
				const fullCalendarUrl = `${credentials.serverUrl}${calendarUrl}`;
				const calendar = account.calendars.find((cal: Calendar) => 
					cal.url === fullCalendarUrl || cal.url.endsWith(calendarUrl)
				);

				if (!calendar) {
					return null;
				}

				// Синхронизируем календарь и получаем события
				const syncedCalendar = await dav.syncCalendar(calendar, {
					xhr: xhr,
					syncMethod: 'basic',
				});
				
				let calendarObjects = syncedCalendar.objects || [];
				
				if (calendarObjects.length === 0) {
					const accountWithObjects = await dav.createAccount({
						server: credentials.serverUrl as string,
						xhr: xhr,
						accountType: 'caldav',
						loadCollections: true,
						loadObjects: true,
					});
					
					const calendarWithObjects = accountWithObjects.calendars.find((cal: Calendar) => 
						cal.url === calendar.url
					);
					
					if (calendarWithObjects && calendarWithObjects.objects) {
						calendarObjects = calendarWithObjects.objects;
					}
				}

				// Ищем событие по UID
				for (const obj of calendarObjects) {
					if (!obj.calendarData) continue;
					
					const calendarData = obj.calendarData;
					const uidMatch = calendarData.match(/UID(?:;[^:]*)?:([^\r\n]+)/);
					
					if (uidMatch && uidMatch[1].trim() === uid) {
						// Проверяем и исправляем URL события если необходимо
						let eventUrl = obj.url;
						
						// Если URL не содержит .ics, добавляем UID как имя файла
						if (!eventUrl.endsWith('.ics')) {
							if (!eventUrl.endsWith('/')) {
								eventUrl += '/';
							}
							eventUrl += `${uid}.ics`;
						}
						
						// Возвращаем объект с исправленным URL
						return {
							...obj,
							url: eventUrl
						};
					}
				}

				return null;
			} catch (error) {
				return null;
			}
		};

		// Улучшенная функция для парсинга iCal дат с поддержкой таймзон
		const parseICalDate = (dateStr: string, eventData: string): ParsedICalDate | null => {
			try {
				const cleanDateStr = dateStr.trim();
				let date: Date;
				let timezone: string | undefined;
				let isUtc = false;

				// Поиск VTIMEZONE в eventData для определения таймзоны
				const timezoneMatch = eventData.match(/DTSTART;TZID=([^:]+):/);
				if (timezoneMatch) {
					timezone = timezoneMatch[1];
				}

				// Парсинг различных форматов дат
				if (cleanDateStr.endsWith('Z')) {
					// UTC формат: 20231025T120000Z
					isUtc = true;
					const year = parseInt(cleanDateStr.substring(0, 4));
					const month = parseInt(cleanDateStr.substring(4, 6)) - 1;
					const day = parseInt(cleanDateStr.substring(6, 8));
					
					if (cleanDateStr.includes('T')) {
						const hour = parseInt(cleanDateStr.substring(9, 11));
						const minute = parseInt(cleanDateStr.substring(11, 13));
						const second = parseInt(cleanDateStr.substring(13, 15));
						date = new Date(Date.UTC(year, month, day, hour, minute, second));
					} else {
						date = new Date(Date.UTC(year, month, day));
					}
				} else if (cleanDateStr.includes('T')) {
					// Формат с временем: YYYYMMDDTHHMMSS
					const year = parseInt(cleanDateStr.substring(0, 4));
					const month = parseInt(cleanDateStr.substring(4, 6)) - 1;
					const day = parseInt(cleanDateStr.substring(6, 8));
					const hour = parseInt(cleanDateStr.substring(9, 11));
					const minute = parseInt(cleanDateStr.substring(11, 13));
					const second = parseInt(cleanDateStr.substring(13, 15));
					
					if (timezone) {
						// Если есть таймзона, создаем дату как локальную, но помечаем таймзону
						date = new Date(year, month, day, hour, minute, second);
					} else {
						// Локальное время
						date = new Date(year, month, day, hour, minute, second);
					}
				} else if (cleanDateStr.includes('-')) {
					// Формат YYYY-MM-DD
					date = new Date(cleanDateStr);
				} else if (cleanDateStr.length === 8) {
					// Формат YYYYMMDD (только дата)
					const year = parseInt(cleanDateStr.substring(0, 4));
					const month = parseInt(cleanDateStr.substring(4, 6)) - 1;
					const day = parseInt(cleanDateStr.substring(6, 8));
					date = new Date(year, month, day);
				} else {
					return null;
				}

				return {
					date,
					timezone,
					isUtc,
					originalString: cleanDateStr
				};
			} catch (error) {
				return null;
			}
		};

		// Функция для конвертации в ISO формат с учетом таймзоны
		const toISOWithTimezone = (parsedDate: ParsedICalDate): string => {
			if (parsedDate.isUtc) {
				return parsedDate.date.toISOString();
			} else if (parsedDate.timezone) {
				// Если есть таймзона, добавляем информацию о ней
				return parsedDate.date.toISOString() + ` (${parsedDate.timezone})`;
			} else {
				// Локальное время
				return parsedDate.date.toISOString();
			}
		};

		// Функция для форматирования даты в iCal формат (YYYYMMDDTHHMMSS)
		const formatDateToICal = (date: Date, isUtc: boolean = false): string => {
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, '0');
			const day = String(date.getDate()).padStart(2, '0');
			const hours = String(date.getHours()).padStart(2, '0');
			const minutes = String(date.getMinutes()).padStart(2, '0');
			const seconds = String(date.getSeconds()).padStart(2, '0');
			
			const dateStr = `${year}${month}${day}T${hours}${minutes}${seconds}`;
			return isUtc ? dateStr + 'Z' : dateStr;
		};

		// Функция для проверки исключенных дат (EXDATE)
		const isDateExcluded = (targetDate: Date, eventData: string): boolean => {
			const exdateMatches = eventData.match(/EXDATE[^:]*:([^\r\n]+)/g);
			if (!exdateMatches) return false;
			
			for (const exdateMatch of exdateMatches) {
				const dateMatch = exdateMatch.match(/EXDATE[^:]*:([^\r\n]+)/);
				if (dateMatch) {
					const exDateStr = dateMatch[1].trim();
					const parsedExDate = parseICalDate(exDateStr, eventData);
					if (parsedExDate) {
						// Сравниваем только дату, игнорируя время
						const exDate = parsedExDate.date;
						if (exDate.getFullYear() === targetDate.getFullYear() &&
							exDate.getMonth() === targetDate.getMonth() &&
							exDate.getDate() === targetDate.getDate()) {
							return true;
						}
					}
				}
			}
			return false;
		};

		// Функция для расчета актуальных дат повторяющегося события для конкретной целевой даты
		const calculateRecurringEventDates = (eventStartDate: Date, eventEndDate: Date | null, targetDate: Date): { actualStartDate: Date, actualEndDate: Date | null } => {
			// Сохраняем время из оригинального события
			const startTime = {
				hours: eventStartDate.getHours(),
				minutes: eventStartDate.getMinutes(),
				seconds: eventStartDate.getSeconds(),
				milliseconds: eventStartDate.getMilliseconds()
			};

			// Создаем актуальную дату начала на целевую дату с оригинальным временем
			const actualStartDate = new Date(targetDate);
			actualStartDate.setHours(startTime.hours, startTime.minutes, startTime.seconds, startTime.milliseconds);

			let actualEndDate: Date | null = null;
			if (eventEndDate) {
				// Рассчитываем продолжительность оригинального события
				const originalDuration = eventEndDate.getTime() - eventStartDate.getTime();
				
				// Создаем актуальную дату окончания
				actualEndDate = new Date(actualStartDate.getTime() + originalDuration);
			}

			return { actualStartDate, actualEndDate };
		};

		// Улучшенная функция для проверки повторяющихся событий
		const isRecurringEventOnDate = (eventStartDate: Date, targetDate: Date, rrule: string, eventData: string): boolean => {
			// Если событие началось после целевой даты, оно не может повториться в прошлом
			if (eventStartDate > targetDate) {
				return false;
			}

			// Проверяем исключенные даты (EXDATE)
			if (isDateExcluded(targetDate, eventData)) {
				return false;
			}

			// Парсим правило повторения
			const rruleParts = rrule.split(';');
			const rules: Record<string, string> = {};
			
			for (const part of rruleParts) {
				const [key, value] = part.split('=');
				if (key && value) {
					rules[key] = value;
				}
			}

			const freq = rules['FREQ'];
			if (!freq) return false;

			// Проверяем окончание повторения
			if (rules['UNTIL']) {
				const untilDate = parseICalDate(rules['UNTIL'], '');
				if (untilDate && targetDate > untilDate.date) {
					return false;
				}
			}

			// Проверяем количество повторений
			if (rules['COUNT']) {
				const count = parseInt(rules['COUNT']);
				const interval = parseInt(rules['INTERVAL'] || '1');
				
				// Рассчитываем количество прошедших интервалов
				const diffTime = targetDate.getTime() - eventStartDate.getTime();
				const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
				
				let intervalsPassed = 0;
				switch (freq) {
					case RecurrenceFrequency.DAILY:
						intervalsPassed = Math.floor(diffDays / interval);
						break;
					case RecurrenceFrequency.WEEKLY:
						intervalsPassed = Math.floor(diffDays / (7 * interval));
						break;
					case RecurrenceFrequency.MONTHLY:
						// Приблизительный расчет для месяцев
						intervalsPassed = Math.floor(diffDays / (30 * interval));
						break;
					case RecurrenceFrequency.YEARLY:
						intervalsPassed = Math.floor(diffDays / (365 * interval));
						break;
				}
				
				if (intervalsPassed >= count) {
					return false;
				}
			}

			// Рассчитываем соответствие дат для каждой частоты
			const interval = parseInt(rules['INTERVAL'] || '1');

			switch (freq) {
				case RecurrenceFrequency.DAILY: {
					const daysDiff = Math.floor((targetDate.getTime() - eventStartDate.getTime()) / (1000 * 60 * 60 * 24));
					return daysDiff >= 0 && daysDiff % interval === 0;
				}

				case RecurrenceFrequency.WEEKLY: {
					// Проверяем дни недели (BYDAY) - ОБЯЗАТЕЛЬНО для недельных событий
					if (rules['BYDAY']) {
						const allowedDays = rules['BYDAY'].split(',');
						const targetDayOfWeek = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][targetDate.getDay()];
						if (!allowedDays.includes(targetDayOfWeek)) {
							return false;
						}
					} else {
						// Если BYDAY не указан, проверяем тот же день недели что и исходное событие
						if (targetDate.getDay() !== eventStartDate.getDay()) {
							return false;
						}
					}
					
					// Вычисляем количество недель между исходным событием и целевой датой
					const msPerDay = 24 * 60 * 60 * 1000;
					const msPerWeek = 7 * msPerDay;
					
					// Находим начало недели для исходного события (понедельник)
					const eventWeekStart = new Date(eventStartDate);
					eventWeekStart.setDate(eventStartDate.getDate() - ((eventStartDate.getDay() + 6) % 7));
					eventWeekStart.setHours(0, 0, 0, 0);
					
					// Находим начало недели для целевой даты
					const targetWeekStart = new Date(targetDate);
					targetWeekStart.setDate(targetDate.getDate() - ((targetDate.getDay() + 6) % 7));
					targetWeekStart.setHours(0, 0, 0, 0);
					
					// Вычисляем разность в неделях
					const weeksDiff = Math.floor((targetWeekStart.getTime() - eventWeekStart.getTime()) / msPerWeek);
					
					// Проверяем соответствие интервалу
					return weeksDiff >= 0 && weeksDiff % interval === 0;
				}

				case RecurrenceFrequency.MONTHLY: {
					// Проверяем конкретный день месяца (BYMONTHDAY)
					if (rules['BYMONTHDAY']) {
						const monthDay = parseInt(rules['BYMONTHDAY']);
						if (targetDate.getDate() !== monthDay) {
							return false;
						}
					} else {
						// Базовая проверка - тот же день месяца, что и в оригинальном событии
						if (targetDate.getDate() !== eventStartDate.getDate()) {
							return false;
						}
					}
					
					// Проверяем месячный интервал
					const monthsDiff = (targetDate.getFullYear() - eventStartDate.getFullYear()) * 12 
						+ (targetDate.getMonth() - eventStartDate.getMonth());
					
					return monthsDiff >= 0 && monthsDiff % interval === 0;
				}

				case RecurrenceFrequency.YEARLY: {
					// Проверяем, что это тот же день и месяц
					if (targetDate.getDate() !== eventStartDate.getDate() || 
						targetDate.getMonth() !== eventStartDate.getMonth()) {
						return false;
					}
					
					const yearsDiff = targetDate.getFullYear() - eventStartDate.getFullYear();
					return yearsDiff >= 0 && yearsDiff % interval === 0;
				}

				default:
					return false;
			}
		};

		// Функция для создания оптимизированного xhr транспорта
		const createOptimizedXhr = (credentials: ICredentialDataDecryptedObject) => {
			// Предупреждаем о проблемах с Yandex CalDAV
			const serverUrl = credentials.serverUrl as string;
			if (serverUrl.includes('yandex.ru')) {
				this.logger?.warn(`[CalDAV WARNING] Connecting to Yandex CalDAV: Known to have artificial 60s/MB delays for WebDAV operations. Updates may timeout frequently.`);
				this.logger?.info(`[CalDAV INFO] Consider using Yandex Calendar API or alternative CalDAV provider for better reliability.`);
			}

			const xhr = new dav.transport.Basic(
				new dav.Credentials({
					username: credentials.username as string,
					password: credentials.password as string,
				})
			);

			// Добавляем кастомный обработчик для оптимизации заголовков
			const originalSend = xhr.send.bind(xhr);
			xhr.send = async function(request: unknown, url: string, headers: Record<string, string> = {}) {
				// Добавляем стандартные заголовки для лучшей совместимости с Yandex
				const optimizedHeaders = {
					'User-Agent': 'n8n-caldav-node/1.0',
					'Accept': 'text/calendar, application/calendar+xml, text/plain',
					'Accept-Encoding': 'identity', // Отключаем сжатие для стабильности
					'Connection': 'close', // Избегаем keep-alive проблем
					...headers
				};

				return originalSend(request, url, optimizedHeaders);
			};

			return xhr;
		};

		// Функция для улучшенной обработки ошибок CalDAV
		const handleCalDAVError = (error: Error & { status?: number }, operation: string, url: string, duration: number): string => {
			let errorMessage = `Failed to ${operation.toLowerCase()} event at ${url}`;
			
			if (error.status) {
				errorMessage += ` - HTTP ${error.status}`;
				if (error.status === 504) {
					errorMessage += ' (Gateway Timeout - server took too long to respond)';
				} else if (error.status === 401) {
					errorMessage += ' (Unauthorized - check credentials)';
				} else if (error.status === 403) {
					errorMessage += ' (Forbidden - insufficient permissions)';
				} else if (error.status === 404) {
					errorMessage += ' (Not Found - resource may not exist)';
				} else if (error.status === 412) {
					errorMessage += ' (Precondition Failed - resource was modified by another client)';
				} else if (error.status === 507) {
					errorMessage += ' (Insufficient Storage - quota exceeded)';
				}
			}
			
			if (error.message) {
				errorMessage += `. Error: ${error.message}`;
			}
			
			errorMessage += `. Request duration: ${duration}ms`;
			
			// Специальная обработка для Yandex CalDAV
			if (url.includes('yandex.ru')) {
				if (error.status === 504 || duration > 3000) {
					errorMessage += '\n\n⚠️  YANDEX CALDAV LIMITATION DETECTED:\n';
					errorMessage += 'Yandex.Disk intentionally adds 60-second delays per MB for WebDAV requests to discourage backup usage.\n';
					errorMessage += 'This is a known Yandex policy since 2021, not a bug in n8n.\n\n';
					errorMessage += '🔧 SOLUTIONS:\n';
					errorMessage += '• Wait a few minutes and try again\n';
					errorMessage += '• Consider using Yandex Calendar API instead of CalDAV\n';
					errorMessage += '• Switch to a different CalDAV provider (Google Calendar, Nextcloud, etc.)\n';
					errorMessage += '• Use Yandex only for reading events, not updating them\n\n';
					errorMessage += '📚 More info: This timeout behavior affects many applications (DEVONthink, Total Commander, etc.)';
				}
			}
			
			return errorMessage;
		};

		for (let i = 0; i < items.length; i++) {
			try {
				if (operation === 'createEvent') {
					const calendarUrl = this.getNodeParameter('calendarUrl', i) as string;
					const eventTitle = this.getNodeParameter('eventTitle', i) as string;
					const startDateTime = new Date(this.getNodeParameter('startDateTime', i) as string);
					const endDateTime = new Date(this.getNodeParameter('endDateTime', i) as string);
					const eventDescription = this.getNodeParameter('eventDescription', i, '') as string;
					const eventLocation = this.getNodeParameter('eventLocation', i, '') as string;

					this.logger?.info(`[CalDAV CREATE] Starting creation of event: ${eventTitle}`);

					// Создаем оптимизированный транспорт для аутентификации
					const xhr = createOptimizedXhr(credentials);

					try {
						// Генерируем iCal данные для события
						const uid = generateEventUID();
						const icalData = generateICalEvent({
							uid,
							title: eventTitle,
							startDateTime,
							endDateTime,
							description: eventDescription,
							location: eventLocation,
						});
						
						this.logger?.info(`[CalDAV CREATE] Generated event UID: ${uid}, iCal length: ${icalData.length} chars`);

						// Создаем аккаунт CalDAV
						const account = await dav.createAccount({
							server: credentials.serverUrl as string,
							xhr: xhr,
							accountType: 'caldav',
							loadCollections: true,
							loadObjects: false,
						});

						// Находим нужный календарь
						const fullCalendarUrl = `${credentials.serverUrl}${calendarUrl}`;
						const calendar = account.calendars.find((cal: Calendar) => 
							cal.url === fullCalendarUrl || cal.url.endsWith(calendarUrl)
						);

						if (!calendar) {
							throw new NodeOperationError(
								this.getNode(),
								`Calendar not found: ${calendarUrl}`,
								{ itemIndex: i }
							);
						}

						this.logger?.info(`[CalDAV CREATE] Calendar found: ${calendar.url}`);

						// Проверяем доступность календаря через синхронизацию
						try {
							await dav.syncCalendar(calendar, {
								xhr: xhr,
								syncMethod: 'basic',
							});
						} catch (syncError) {
							const errorMessage = syncError instanceof Error ? syncError.message : 'Unknown sync error';
							throw new NodeOperationError(
								this.getNode(),
								`Calendar not accessible: ${errorMessage}. Please check calendar URL and credentials.`,
								{ itemIndex: i }
							);
						}

						// Создаем событие в календаре
						let eventUrl = calendar.url;
						if (!eventUrl.endsWith('/')) {
							eventUrl += '/';
						}
						eventUrl += `${uid}.ics`;
						
						this.logger?.info(`[CalDAV CREATE] Making PUT request to: ${eventUrl}`);
						
						// Создаем объект события для CalDAV используя встроенный xhr транспорт
						const request = {
							method: 'PUT',
							requestData: icalData,
							transformRequest: (data: unknown) => data,
							transformResponse: (data: unknown) => data,
						};
						
						let createdEvent: { url: string; etag: string; calendarData: string };
						const requestStartTime = Date.now();
						
						try {
							// Используем xhr.send с правильными параметрами
							const response = await xhr.send(request, eventUrl, {
								'Content-Type': 'text/calendar; charset=utf-8',
							});

							const requestDuration = Date.now() - requestStartTime;
							this.logger?.info(`[CalDAV CREATE] PUT request completed successfully in ${requestDuration}ms`);

							createdEvent = {
								url: eventUrl,
								etag: response.xhr?.getResponseHeader?.('etag') || '',
								calendarData: icalData,
							};
						} catch (httpError) {
							const requestDuration = Date.now() - requestStartTime;
							const status = (httpError as { status?: number }).status || 'No status';
							this.logger?.error(`[CalDAV CREATE] PUT request failed after ${requestDuration}ms, status: ${status}`);
							
							// Альтернативный подход - попробуем создать временный файл и синхронизировать
							try {
								this.logger?.info(`[CalDAV CREATE] Trying alternative sync method...`);
								// Создаем временный объект календаря
								const tempCalendarObject = {
									url: eventUrl,
									etag: '',
									calendarData: icalData,
								};
								
								// Добавляем объект в календарь вручную и синхронизируем
								if (!calendar.objects) {
									calendar.objects = [];
								}
								calendar.objects.push(tempCalendarObject);
								
								// Пытаемся синхронизировать календарь с новым объектом
								await dav.syncCalendar(calendar, {
									xhr: xhr,
									syncMethod: 'basic',
								});
								
								createdEvent = {
									url: eventUrl,
									etag: '',
									calendarData: icalData,
								};
								
							} catch (syncError) {
								// Если и альтернативный метод не работает, выдаем подробную ошибку
								const httpErr = httpError as { status?: number; message?: string };
								const syncErr = syncError as { message?: string };
								let errorMessage = `Failed to create event at ${eventUrl}`;
								
								if (httpErr.status) {
									errorMessage += ` - HTTP ${httpErr.status}`;
									if (httpErr.status === 504) {
										errorMessage += ' (Gateway Timeout - server took too long to respond)';
									} else if (httpErr.status === 401) {
										errorMessage += ' (Unauthorized - check credentials)';
									} else if (httpErr.status === 403) {
										errorMessage += ' (Forbidden - insufficient permissions)';
									} else if (httpErr.status === 404) {
										errorMessage += ' (Not Found - calendar may not exist)';
									}
								}
								
								if (httpErr.message) {
									errorMessage += `. Original error: ${httpErr.message}`;
								}
								
								const syncMessage = syncErr.message || 'Unknown sync error';
								errorMessage += `. Alternative sync method also failed: ${syncMessage}`;
								
								throw new NodeOperationError(
									this.getNode(),
									errorMessage,
									{ itemIndex: i }
								);
							}
						}

						returnData.push({
							json: {
								uid,
								title: eventTitle,
								startDateTime: startDateTime.toISOString(),
								endDateTime: endDateTime.toISOString(),
								description: eventDescription,
								location: eventLocation,
								url: createdEvent.url,
								etag: createdEvent.etag,
								success: true,
								message: 'Event created successfully',
							},
							pairedItem: {
								item: i,
							},
						});

					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`Failed to create event: ${(error as Error).message}`,
							{ itemIndex: i }
						);
					}

				} else if (operation === 'deleteEvent') {
					const calendarUrl = this.getNodeParameter('calendarUrl', i) as string;
					const eventUID = this.getNodeParameter('eventUID', i) as string;

					this.logger?.info(`[CalDAV DELETE] Starting deletion of event UID: ${eventUID}`);

					// Создаем оптимизированный транспорт для аутентификации
					const xhr = createOptimizedXhr(credentials);

					try {
						// Находим существующее событие
						let existingEvent = await findEventByUID(calendarUrl, eventUID, xhr);
						
						this.logger?.info(`[CalDAV DELETE] findEventByUID result: ${existingEvent ? 'Found' : 'Not found'}`);
						
						// Если не найдено через синхронизацию, пробуем прямой запрос
						if (!existingEvent) {
							this.logger?.info(`[CalDAV DELETE] Trying findEventByFilename as fallback...`);
							existingEvent = await findEventByFilename(calendarUrl, eventUID, xhr);
							this.logger?.info(`[CalDAV DELETE] findEventByFilename result: ${existingEvent ? 'Found' : 'Not found'}`);
						}
						
						if (!existingEvent) {
							throw new NodeOperationError(
								this.getNode(),
								`Event with UID ${eventUID} not found in calendar ${calendarUrl}. Tried both sync and direct methods.`,
								{ itemIndex: i }
							);
						}

						this.logger?.info(`[CalDAV DELETE] Event found at URL: ${existingEvent.url}`);

						// Удаляем событие используя xhr транспорт
						const deleteRequest = {
							method: 'DELETE',
							requestData: '',
							transformRequest: (data: unknown) => data,
							transformResponse: (data: unknown) => data,
						};
						
						const deleteHeaders: Record<string, string> = {};
						
						if (existingEvent.etag) {
							deleteHeaders['If-Match'] = existingEvent.etag;
							this.logger?.debug(`[CalDAV DELETE] Using If-Match header with etag: ${existingEvent.etag}`);
						}
						
						this.logger?.info(`[CalDAV DELETE] Making DELETE request to: ${existingEvent.url}`);
						const requestStartTime = Date.now();
						
						try {
							await xhr.send(deleteRequest, existingEvent.url, deleteHeaders);
							const requestDuration = Date.now() - requestStartTime;
							
							this.logger?.info(`[CalDAV DELETE] DELETE request completed successfully in ${requestDuration}ms`);

							returnData.push({
								json: {
									uid: eventUID,
									url: existingEvent.url,
									success: true,
									message: 'Event deleted successfully',
									deletedAt: new Date().toISOString(),
								},
								pairedItem: {
									item: i,
								},
							});

						} catch (httpError) {
							const requestDuration = Date.now() - requestStartTime;
							const status = (httpError as { status?: number }).status || 'No status';
							this.logger?.error(`[CalDAV DELETE] DELETE request failed after ${requestDuration}ms, status: ${status}`);
							
							// Используем улучшенную обработку ошибок
							const errorMessage = handleCalDAVError(httpError as Error & { status?: number }, 'DELETE', existingEvent.url, requestDuration);
							
							throw new NodeOperationError(
								this.getNode(),
								errorMessage,
								{ itemIndex: i }
							);
						}

					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`Failed to delete event: ${(error as Error).message}`,
							{ itemIndex: i }
						);
					}

				} else if (operation === 'getEvents') {
					const calendarUrl = this.getNodeParameter('calendarUrl', i) as string;
					const date = this.getNodeParameter('date', i) as string;

					this.logger?.info(`[CalDAV GET] Getting events for date: ${date} from calendar: ${calendarUrl}`);

					// Создаем оптимизированный транспорт для аутентификации
					const xhr = createOptimizedXhr(credentials);

					try {
						// Создаем аккаунт CalDAV
						const account = await dav.createAccount({
							server: credentials.serverUrl as string,
							xhr: xhr,
							accountType: 'caldav',
							loadCollections: true,
							loadObjects: false,
						});

						// Находим нужный календарь по URL
						const fullCalendarUrl = `${credentials.serverUrl}${calendarUrl}`;
						
						const calendar = account.calendars.find((cal: Calendar) => 
							cal.url === fullCalendarUrl || cal.url.endsWith(calendarUrl)
						);

						if (!calendar) {
													// Prepare convenient calendar list for user
						const calendarList = account.calendars.map((cal: Calendar) => {
							const serverUrl = credentials.serverUrl as string;
							let calendarPath = cal.url;
							
							// Remove serverUrl for brevity
							if (calendarPath.startsWith(serverUrl)) {
								calendarPath = calendarPath.substring(serverUrl.length);
							}
							
							// Determine calendar type
							let type = 'calendar';
							if (calendarPath.includes('events')) {
								type = 'events';
							} else if (calendarPath.includes('todos') || calendarPath.includes('tasks')) {
								type = 'tasks';
							}
							
							return `  📅 ${calendarPath} (${type})`;
						}).join('\n');

						throw new NodeOperationError(
							this.getNode(),
							`❌ Calendar not found: ${calendarUrl}\n\n📋 Available calendars:\n${calendarList}\n\n💡 Copy the needed path from the list above to "Calendar URL" field`,
							{ level: 'warning' }
						);
						}

						// Form date range for request (day from 00:00 to 23:59)
						const targetDate = new Date(date);
						const startDate = new Date(targetDate);
						startDate.setHours(0, 0, 0, 0);
						
						const endDate = new Date(targetDate);
						endDate.setHours(23, 59, 59, 999);

						// Synchronize calendar and get events
						const syncedCalendar = await dav.syncCalendar(calendar, {
							xhr: xhr,
							syncMethod: 'basic',
						});
						
						// If no objects after sync, try to create account with loading objects
						let calendarObjects = syncedCalendar.objects || [];
						
						if (calendarObjects.length === 0) {
							// Create new account with loading objects
							const accountWithObjects = await dav.createAccount({
								server: credentials.serverUrl as string,
								xhr: xhr,
								accountType: 'caldav',
								loadCollections: true,
								loadObjects: true,
							});
							
							// Find the same calendar in new account
							const calendarWithObjects = accountWithObjects.calendars.find((cal: Calendar) => 
								cal.url === calendar.url
							);
							
							if (calendarWithObjects && calendarWithObjects.objects) {
								calendarObjects = calendarWithObjects.objects;
							}
						}
						
						// Filter events by date
						const eventsForDate: CalendarEvent[] = [];
						
						this.logger?.info(`[CalDAV GET] Processing ${calendarObjects.length} calendar objects`);
						
						for (const obj of calendarObjects) {
							if (!obj.calendarData) continue;
							
							const calendarData = obj.calendarData;
							
							// Извлекаем все блоки VEVENT
							const veventBlocks = calendarData.split('BEGIN:VEVENT').slice(1);
							
							for (const veventBlock of veventBlocks) {
								if (!veventBlock.includes('END:VEVENT')) continue;
								
								const eventData = 'BEGIN:VEVENT' + veventBlock.split('END:VEVENT')[0] + 'END:VEVENT';
								
								// Ищем DTSTART в конкретном событии
								const eventDateMatches = [
									eventData.match(/DTSTART[^:]*:(\d{8}T\d{6}Z?)/), // Формат YYYYMMDDTHHMMSSZ
									eventData.match(/DTSTART[^:]*:(\d{8})/), // Формат YYYYMMDD
									eventData.match(/DTSTART[^:]*:(\d{4}-\d{2}-\d{2})/), // Формат YYYY-MM-DD
								];
								
								for (const match of eventDateMatches) {
									if (!match) continue;
									
									const dateStr = match[1];
									const parsedDate = parseICalDate(dateStr, eventData);
									
									if (!parsedDate) continue;
									
									const eventDate = parsedDate.date;
									
									// Проверяем прямое совпадение даты
									if (eventDate.toDateString() === targetDate.toDateString()) {
										eventsForDate.push({
											...obj,
											calendarData: eventData
										});
										break;
									}
									
									// Проверяем правила повторения (RRULE)
									const rruleMatch = eventData.match(/RRULE(?:;[^:]*)?:([^\r\n]+)/);
									if (rruleMatch && isRecurringEventOnDate(eventDate, targetDate, rruleMatch[1], eventData)) {
										// Для повторяющихся событий рассчитываем актуальные даты
										// Парсим также DTEND для расчета продолжительности
										const dtEndMatch = eventData.match(/DTEND[^:]*:(.+)/);
										const dtEndStr = dtEndMatch ? dtEndMatch[1].trim() : '';
										const parsedEndDate = dtEndStr ? parseICalDate(dtEndStr, eventData) : null;
										
										// Рассчитываем актуальные даты для целевой даты
										const { actualStartDate, actualEndDate } = calculateRecurringEventDates(
											eventDate, 
											parsedEndDate?.date || null, 
											targetDate
										);
										
										// Создаем модифицированные данные события с актуальными датами
										let modifiedEventData = eventData;
										
										// Заменяем DTSTART на актуальную дату
										const originalDtStart = eventData.match(/DTSTART[^:]*:([^\r\n]+)/);
										if (originalDtStart) {
											const isUtcStart = parsedDate.isUtc;
											const actualStartStr = formatDateToICal(actualStartDate, isUtcStart);
											const startLine = originalDtStart[0];
											const newStartLine = startLine.replace(originalDtStart[1], actualStartStr);
											modifiedEventData = modifiedEventData.replace(startLine, newStartLine);
										}
										
										// Заменяем DTEND на актуальную дату (если существует)
										if (actualEndDate && dtEndMatch) {
											const isUtcEnd = parsedEndDate?.isUtc || false;
											const actualEndStr = formatDateToICal(actualEndDate, isUtcEnd);
											const endLine = dtEndMatch[0];
											const newEndLine = endLine.replace(dtEndMatch[1], actualEndStr);
											modifiedEventData = modifiedEventData.replace(endLine, newEndLine);
										}
										
										eventsForDate.push({
											...obj,
											calendarData: modifiedEventData
										});
									}
									break;
								}
							}
						}

						this.logger?.info(`[CalDAV GET] Found ${eventsForDate.length} events for date ${date}`);

						// Process found events
						for (const event of eventsForDate) {
							const eventData = event.calendarData;
							
							// Проверяем, что eventData существует
							if (!eventData) {
								continue;
							}
							
							// Извлекаем основную информацию о событии
							// RFC 5545 §3.5: any property may carry parameters between
							// the property name and the value separator (e.g. Outlook /
							// Exchange emit `SUMMARY;LANGUAGE=de-DE:...`). The non-
							// capturing `(?:;[^:]*)?` swallows them so `:(.+)` lands on
							// the value. Mirrors the existing DTSTART pattern.
							const summaryMatch = eventData.match(/SUMMARY(?:;[^:]*)?:(.+)/);
							const descriptionMatch = eventData.match(/DESCRIPTION(?:;[^:]*)?:(.+)/);
							const dtStartMatch = eventData.match(/DTSTART[^:]*:(.+)/);
							const dtEndMatch = eventData.match(/DTEND[^:]*:(.+)/);
							const uidMatch = eventData.match(/UID(?:;[^:]*)?:(.+)/);
							const locationMatch = eventData.match(/LOCATION(?:;[^:]*)?:(.+)/);
							const webUrlMatch = eventData.match(/URL(?:;[^:]*)?:(.+)/);

							// Парсим даты для ISO формата
							const dtStartRaw = dtStartMatch ? dtStartMatch[1].trim() : '';
							const dtEndRaw = dtEndMatch ? dtEndMatch[1].trim() : '';
							
							const parsedStartDate = dtStartRaw ? parseICalDate(dtStartRaw, eventData) : null;
							const parsedEndDate = dtEndRaw ? parseICalDate(dtEndRaw, eventData) : null;

							const eventInfo = {
								uid: uidMatch ? uidMatch[1].trim() : '',
								summary: summaryMatch ? summaryMatch[1].trim() : '',
								description: descriptionMatch ? descriptionMatch[1].trim() : '',
								location: locationMatch ? locationMatch[1].trim() : '',
								webUrl: webUrlMatch ? webUrlMatch[1].trim() : '',
								dtStart: dtStartRaw,
								dtEnd: dtEndRaw,
								dtStartISO: parsedStartDate ? toISOWithTimezone(parsedStartDate) : '',
								dtEndISO: parsedEndDate ? toISOWithTimezone(parsedEndDate) : '',
								url: event.url,
								etag: event.etag,
								calendarData: eventData,
							};

							returnData.push({
								json: eventInfo,
								pairedItem: {
									item: i,
								},
							});
						}

						// If no events found, return search information
						if (eventsForDate.length === 0) {
							// Add sample events for debugging
							const sampleEvents: SampleEvent[] = [];
							
							// Analyze first few calendar objects
							for (let i = 0; i < Math.min(2, calendarObjects.length); i++) {
								const obj = calendarObjects[i];
								if (!obj.calendarData) {
									sampleEvents.push({ error: 'No calendarData' });
									continue;
								}
								
								const calendarData = obj.calendarData;
								const veventBlocks = calendarData.split('BEGIN:VEVENT').slice(1);
								
								sampleEvents.push({
									objectIndex: i,
									totalVEventBlocks: veventBlocks.length,
									firstVEventPreview: veventBlocks.length > 0 ? 
										('BEGIN:VEVENT' + veventBlocks[0].split('END:VEVENT')[0]).substring(0, 300) + '...' : 'No VEVENT found',
									calendarDataStart: calendarData.substring(0, 200) + '...'
								});
								
								// Show first 2 events from this object
								for (let j = 0; j < Math.min(2, veventBlocks.length); j++) {
									const veventBlock = veventBlocks[j];
									if (!veventBlock.includes('END:VEVENT')) continue;
									
									const eventData = 'BEGIN:VEVENT' + veventBlock.split('END:VEVENT')[0] + 'END:VEVENT';
									const dtStartMatch = eventData.match(/DTSTART[^:]*:([^\r\n]+)/);
									const summaryMatch = eventData.match(/SUMMARY(?:;[^:]*)?:([^\r\n]+)/);
									
									sampleEvents.push({
										objectIndex: i,
										eventIndex: j,
										dtStart: dtStartMatch ? dtStartMatch[1] : 'No DTSTART found',
										summary: summaryMatch ? summaryMatch[1] : 'No SUMMARY found',
										eventDataPreview: eventData.substring(0, 200) + '...'
									});
								}
							}

							// Throw error when no events found
							throw new NodeOperationError(
								this.getNode(),
								`No events found for ${targetDate.toDateString()}. Calendar: ${calendarUrl}, Objects found: ${calendarObjects.length}`,
								{
									itemIndex: i,
									description: 'No events found for the specified date',
								}
							);
						}

					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`CalDAV request failed: ${(error as Error).message}`,
							{ itemIndex: i }
						);
					}
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: (error as Error).message,
						},
						pairedItem: {
							item: i,
						},
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
} 