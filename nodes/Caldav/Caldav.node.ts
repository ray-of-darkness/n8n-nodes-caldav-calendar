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

import { DAVClient, DAVCalendar, DAVCalendarObject } from 'tsdav';

/**
 * Enum for recurrence frequencies in RRULE
 */
enum RecurrenceFrequency {
	DAILY = 'DAILY',
	WEEKLY = 'WEEKLY',
	MONTHLY = 'MONTHLY',
	YEARLY = 'YEARLY'
}

/**
 * Calendar event with support for various date formats
 */
interface CalendarEvent {
	summary?: string;
	start?: Date | string;
	end?: Date | string;
	description?: string;
	location?: string;
	uid?: string;
	url?: string;
	etag?: string;
	calendarData?: string;
}

/**
 * Parsed iCal date structure
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

/**
 * Create an authenticated tsdav DAVClient from n8n credentials.
 */
async function createDavClient(credentials: ICredentialDataDecryptedObject): Promise<DAVClient> {
	const client = new DAVClient({
		serverUrl: credentials.serverUrl as string,
		credentials: {
			username: credentials.username as string,
			password: credentials.password as string,
		},
		authMethod: 'Basic',
		defaultAccountType: 'caldav',
	});
	await client.login();
	return client;
}

/**
 * Fetch all calendar objects from a calendar using tsdav.
 * No timeRange / expand — fetches everything, same as the original dav.syncCalendar behaviour.
 */
async function fetchAllCalendarObjects(
	client: DAVClient,
	calendar: DAVCalendar,
): Promise<DAVCalendarObject[]> {
	const objects = await client.fetchCalendarObjects({ calendar });
	return objects;
}

/**
 * Perform a raw HTTP request using fetch (replaces dav xhr.send for PUT/DELETE/GET).
 */
async function rawRequest(
	credentials: ICredentialDataDecryptedObject,
	method: string,
	url: string,
	body?: string,
	extraHeaders?: Record<string, string>,
): Promise<{ status: number; statusText: string; body: string; headers: Headers }> {
	// Resolve relative URLs against the server base URL
	const absoluteUrl = url.startsWith('http') ? url : new URL(url, credentials.serverUrl as string).toString();

	const authString = Buffer.from(
		`${credentials.username as string}:${credentials.password as string}`,
	).toString('base64');

	const headers: Record<string, string> = {
		'Authorization': `Basic ${authString}`,
		'User-Agent': 'n8n-caldav-node/3.0',
		'Accept': 'text/calendar, application/calendar+xml, text/plain',
		'Connection': 'close',
		...extraHeaders,
	};

	const resp = await fetch(absoluteUrl, {
		method,
		headers,
		body: body || undefined,
	});

	const respBody = await resp.text();
	return { status: resp.status, statusText: resp.statusText, body: respBody, headers: resp.headers };
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
					const client = await createDavClient(credentials);
					const calendars = await client.fetchCalendars();

					const calendarOptions: INodePropertyOptions[] = [];

					for (const calendar of calendars) {
						const serverUrl = credentials.serverUrl as string;
						let calendarPath = calendar.url;

						if (calendarPath.startsWith(serverUrl)) {
							calendarPath = calendarPath.substring(serverUrl.length);
						}

						if (!calendarPath.startsWith('/')) {
							calendarPath = '/' + calendarPath;
						}

						let calendarName = '';

						if (calendar.displayName && typeof calendar.displayName === 'string') {
							calendarName = calendar.displayName;
						} else {
							const pathParts = calendarPath.split('/').filter(part => part.length > 0);
							calendarName = pathParts[pathParts.length - 1] || calendarPath;
							if (calendarName.endsWith('/')) {
								calendarName = calendarName.slice(0, -1);
							}
						}

						let calendarType = 'Calendar';
						const components = calendar.components || [];
						if (components.includes('VEVENT') || calendarPath.includes('events')) {
							calendarType = 'Events';
						} else if (components.includes('VTODO') || calendarPath.includes('todos') || calendarPath.includes('tasks')) {
							calendarType = 'Tasks';
						}

						const displayName = calendarName ? `${calendarName} (${calendarType})` : `${calendarType} - ${calendarPath}`;

						calendarOptions.push({
							name: displayName,
							value: calendarPath,
							description: `Path: ${calendarPath}`,
						});
					}

					calendarOptions.sort((a, b) => a.name.localeCompare(b.name));

					return calendarOptions;

				} catch (error) {
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

		// Helper: find a calendar by the user-selected relative path
		const findCalendar = (calendars: DAVCalendar[], calendarUrl: string): DAVCalendar | undefined => {
			const fullCalendarUrl = `${credentials.serverUrl}${calendarUrl}`;
			return calendars.find((cal) =>
				cal.url === fullCalendarUrl || cal.url.endsWith(calendarUrl)
			);
		};

		// Helper: find event by UID in calendar objects
		const findEventByUID = (objects: DAVCalendarObject[], uid: string): { url: string; etag: string; calendarData: string } | null => {
			for (const obj of objects) {
				const calendarData = obj.data;
				if (!calendarData) continue;

				const uidMatch = calendarData.match(/UID:([^\r\n]+)/);
				if (uidMatch && uidMatch[1].trim() === uid) {
					let eventUrl = obj.url;
					if (!eventUrl.endsWith('.ics')) {
						if (!eventUrl.endsWith('/')) {
							eventUrl += '/';
						}
						eventUrl += `${uid}.ics`;
					}

					return {
						url: eventUrl,
						etag: obj.etag || '',
						calendarData,
					};
				}
			}
			return null;
		};

		// Improved function for parsing iCal dates with timezone support
		const parseICalDate = (dateStr: string, eventData: string): ParsedICalDate | null => {
			try {
				const cleanDateStr = dateStr.trim();
				let date: Date;
				let timezone: string | undefined;
				let isUtc = false;

				const timezoneMatch = eventData.match(/DTSTART;TZID=([^:]+):/);
				if (timezoneMatch) {
					timezone = timezoneMatch[1];
				}

				if (cleanDateStr.endsWith('Z')) {
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
					const year = parseInt(cleanDateStr.substring(0, 4));
					const month = parseInt(cleanDateStr.substring(4, 6)) - 1;
					const day = parseInt(cleanDateStr.substring(6, 8));
					const hour = parseInt(cleanDateStr.substring(9, 11));
					const minute = parseInt(cleanDateStr.substring(11, 13));
					const second = parseInt(cleanDateStr.substring(13, 15));
					date = new Date(year, month, day, hour, minute, second);
				} else if (cleanDateStr.includes('-')) {
					date = new Date(cleanDateStr);
				} else if (cleanDateStr.length === 8) {
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

		// Convert to ISO format with timezone info
		const toISOWithTimezone = (parsedDate: ParsedICalDate): string => {
			if (parsedDate.isUtc) {
				return parsedDate.date.toISOString();
			} else if (parsedDate.timezone) {
				return parsedDate.date.toISOString() + ` (${parsedDate.timezone})`;
			} else {
				return parsedDate.date.toISOString();
			}
		};

		// Format date to iCal format (YYYYMMDDTHHMMSS)
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

		// Check excluded dates (EXDATE)
		const isDateExcluded = (targetDate: Date, eventData: string): boolean => {
			const exdateMatches = eventData.match(/EXDATE[^:]*:([^\r\n]+)/g);
			if (!exdateMatches) return false;

			for (const exdateMatch of exdateMatches) {
				const dateMatch = exdateMatch.match(/EXDATE[^:]*:([^\r\n]+)/);
				if (dateMatch) {
					const exDateStr = dateMatch[1].trim();
					const parsedExDate = parseICalDate(exDateStr, eventData);
					if (parsedExDate) {
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

		// Calculate actual dates for a recurring event on a specific target date
		const calculateRecurringEventDates = (eventStartDate: Date, eventEndDate: Date | null, targetDate: Date): { actualStartDate: Date, actualEndDate: Date | null } => {
			const startTime = {
				hours: eventStartDate.getHours(),
				minutes: eventStartDate.getMinutes(),
				seconds: eventStartDate.getSeconds(),
				milliseconds: eventStartDate.getMilliseconds()
			};

			const actualStartDate = new Date(targetDate);
			actualStartDate.setHours(startTime.hours, startTime.minutes, startTime.seconds, startTime.milliseconds);

			let actualEndDate: Date | null = null;
			if (eventEndDate) {
				const originalDuration = eventEndDate.getTime() - eventStartDate.getTime();
				actualEndDate = new Date(actualStartDate.getTime() + originalDuration);
			}

			return { actualStartDate, actualEndDate };
		};

		// Improved function for checking recurring events
		const isRecurringEventOnDate = (eventStartDate: Date, targetDate: Date, rrule: string, eventData: string): boolean => {
			if (eventStartDate > targetDate) {
				return false;
			}

			if (isDateExcluded(targetDate, eventData)) {
				return false;
			}

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

			if (rules['UNTIL']) {
				const untilDate = parseICalDate(rules['UNTIL'], '');
				if (untilDate && targetDate > untilDate.date) {
					return false;
				}
			}

			if (rules['COUNT']) {
				const count = parseInt(rules['COUNT']);
				const interval = parseInt(rules['INTERVAL'] || '1');

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

			const interval = parseInt(rules['INTERVAL'] || '1');

			switch (freq) {
				case RecurrenceFrequency.DAILY: {
					const daysDiff = Math.floor((targetDate.getTime() - eventStartDate.getTime()) / (1000 * 60 * 60 * 24));
					return daysDiff >= 0 && daysDiff % interval === 0;
				}

				case RecurrenceFrequency.WEEKLY: {
					if (rules['BYDAY']) {
						const allowedDays = rules['BYDAY'].split(',');
						const targetDayOfWeek = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][targetDate.getDay()];
						if (!allowedDays.includes(targetDayOfWeek)) {
							return false;
						}
					} else {
						if (targetDate.getDay() !== eventStartDate.getDay()) {
							return false;
						}
					}

					const msPerWeek = 7 * 24 * 60 * 60 * 1000;

					const eventWeekStart = new Date(eventStartDate);
					eventWeekStart.setDate(eventStartDate.getDate() - ((eventStartDate.getDay() + 6) % 7));
					eventWeekStart.setHours(0, 0, 0, 0);

					const targetWeekStart = new Date(targetDate);
					targetWeekStart.setDate(targetDate.getDate() - ((targetDate.getDay() + 6) % 7));
					targetWeekStart.setHours(0, 0, 0, 0);

					const weeksDiff = Math.floor((targetWeekStart.getTime() - eventWeekStart.getTime()) / msPerWeek);

					return weeksDiff >= 0 && weeksDiff % interval === 0;
				}

				case RecurrenceFrequency.MONTHLY: {
					if (rules['BYMONTHDAY']) {
						const monthDay = parseInt(rules['BYMONTHDAY']);
						if (targetDate.getDate() !== monthDay) {
							return false;
						}
					} else {
						if (targetDate.getDate() !== eventStartDate.getDate()) {
							return false;
						}
					}

					const monthsDiff = (targetDate.getFullYear() - eventStartDate.getFullYear()) * 12
						+ (targetDate.getMonth() - eventStartDate.getMonth());

					return monthsDiff >= 0 && monthsDiff % interval === 0;
				}

				case RecurrenceFrequency.YEARLY: {
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

		// Improved CalDAV error handling
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

			return errorMessage;
		};

		// Create client and fetch calendars once, reuse across all items
		const client = await createDavClient(credentials);
		const calendars = await client.fetchCalendars();

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

					const calendar = findCalendar(calendars, calendarUrl);
					if (!calendar) {
						throw new NodeOperationError(
							this.getNode(),
							`Calendar not found: ${calendarUrl}`,
							{ itemIndex: i }
						);
					}

					this.logger?.info(`[CalDAV CREATE] Calendar found: ${calendar.url}`);

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

					// Build event URL
					let eventUrl = calendar.url;
					if (!eventUrl.endsWith('/')) {
						eventUrl += '/';
					}
					eventUrl += `${uid}.ics`;

					this.logger?.info(`[CalDAV CREATE] Making PUT request to: ${eventUrl}`);
					const requestStartTime = Date.now();

					try {
						const resp = await rawRequest(credentials, 'PUT', eventUrl, icalData, {
							'Content-Type': 'text/calendar; charset=utf-8',
						});

						const requestDuration = Date.now() - requestStartTime;

						if (resp.status >= 200 && resp.status < 300) {
							this.logger?.info(`[CalDAV CREATE] PUT request completed successfully in ${requestDuration}ms`);
						} else {
							throw Object.assign(new Error(`HTTP ${resp.status} ${resp.statusText}`), { status: resp.status });
						}

						returnData.push({
							json: {
								uid,
								title: eventTitle,
								startDateTime: startDateTime.toISOString(),
								endDateTime: endDateTime.toISOString(),
								description: eventDescription,
								location: eventLocation,
								url: eventUrl,
								etag: resp.headers.get('etag') || '',
								success: true,
								message: 'Event created successfully',
							},
							pairedItem: { item: i },
						});

					} catch (httpError) {
						const requestDuration = Date.now() - requestStartTime;
						const errorMessage = handleCalDAVError(httpError as Error & { status?: number }, 'CREATE', eventUrl, requestDuration);
						throw new NodeOperationError(this.getNode(), errorMessage, { itemIndex: i });
					}

				} else if (operation === 'deleteEvent') {
					const calendarUrl = this.getNodeParameter('calendarUrl', i) as string;
					const eventUID = this.getNodeParameter('eventUID', i) as string;

					this.logger?.info(`[CalDAV DELETE] Starting deletion of event UID: ${eventUID}`);

					const calendar = findCalendar(calendars, calendarUrl);
					if (!calendar) {
						throw new NodeOperationError(
							this.getNode(),
							`Calendar not found: ${calendarUrl}`,
							{ itemIndex: i }
						);
					}

					// Fetch all objects to find the event by UID
					const objects = await fetchAllCalendarObjects(client, calendar);
					let existingEvent = findEventByUID(objects, eventUID);

					this.logger?.info(`[CalDAV DELETE] findEventByUID result: ${existingEvent ? 'Found' : 'Not found'}`);

					// Fallback: try direct URL
					if (!existingEvent) {
						let directUrl = calendar.url;
						if (!directUrl.endsWith('/')) {
							directUrl += '/';
						}
						directUrl += `${eventUID}.ics`;

						this.logger?.info(`[CalDAV DELETE] Trying direct URL: ${directUrl}`);

						try {
							const getResp = await rawRequest(credentials, 'GET', directUrl);
							if (getResp.status === 200 && getResp.body) {
								existingEvent = {
									url: directUrl,
									etag: getResp.headers.get('etag') || '',
									calendarData: getResp.body,
								};
							}
						} catch (_e) {
							// Direct fetch failed, event not found
						}
					}

					if (!existingEvent) {
						throw new NodeOperationError(
							this.getNode(),
							`Event with UID ${eventUID} not found in calendar ${calendarUrl}. Tried both sync and direct methods.`,
							{ itemIndex: i }
						);
					}

					this.logger?.info(`[CalDAV DELETE] Event found at URL: ${existingEvent.url}`);

					const deleteHeaders: Record<string, string> = {};
					if (existingEvent.etag) {
						deleteHeaders['If-Match'] = existingEvent.etag;
					}

					this.logger?.info(`[CalDAV DELETE] Making DELETE request to: ${existingEvent.url}`);
					const requestStartTime = Date.now();

					try {
						const resp = await rawRequest(credentials, 'DELETE', existingEvent.url, '', deleteHeaders);
						const requestDuration = Date.now() - requestStartTime;

						if (resp.status >= 200 && resp.status < 300) {
							this.logger?.info(`[CalDAV DELETE] DELETE request completed successfully in ${requestDuration}ms`);
						} else {
							throw Object.assign(new Error(`HTTP ${resp.status} ${resp.statusText}`), { status: resp.status });
						}

						returnData.push({
							json: {
								uid: eventUID,
								url: existingEvent.url,
								success: true,
								message: 'Event deleted successfully',
								deletedAt: new Date().toISOString(),
							},
							pairedItem: { item: i },
						});

					} catch (httpError) {
						const requestDuration = Date.now() - requestStartTime;
						const errorMessage = handleCalDAVError(httpError as Error & { status?: number }, 'DELETE', existingEvent.url, requestDuration);
						throw new NodeOperationError(this.getNode(), errorMessage, { itemIndex: i });
					}

				} else if (operation === 'getEvents') {
					const calendarUrl = this.getNodeParameter('calendarUrl', i) as string;
					const date = this.getNodeParameter('date', i) as string;

					this.logger?.info(`[CalDAV GET] Getting events for date: ${date} from calendar: ${calendarUrl}`);

					const calendar = findCalendar(calendars, calendarUrl);

					if (!calendar) {
						const calendarList = calendars.map((cal) => {
							const serverUrl = credentials.serverUrl as string;
							let calendarPath = cal.url;
							if (calendarPath.startsWith(serverUrl)) {
								calendarPath = calendarPath.substring(serverUrl.length);
							}
							let type = 'calendar';
							if (calendarPath.includes('events')) {
								type = 'events';
							} else if (calendarPath.includes('todos') || calendarPath.includes('tasks')) {
								type = 'tasks';
							}
							return `  ${calendarPath} (${type})`;
						}).join('\n');

						throw new NodeOperationError(
							this.getNode(),
							`Calendar not found: ${calendarUrl}\n\nAvailable calendars:\n${calendarList}\n\nCopy the needed path from the list above to "Calendar URL" field`,
							{ level: 'warning' }
						);
					}

					// Form date range for request
					const targetDate = new Date(date);
					const startDate = new Date(targetDate);
					startDate.setHours(0, 0, 0, 0);

					const endDate = new Date(targetDate);
					endDate.setHours(23, 59, 59, 999);

					// Fetch all calendar objects (same as original dav.syncCalendar behaviour)
					const calendarObjects = await fetchAllCalendarObjects(client, calendar);

					// Filter events by date
					const eventsForDate: CalendarEvent[] = [];

					this.logger?.info(`[CalDAV GET] Processing ${calendarObjects.length} calendar objects`);

					for (const obj of calendarObjects) {
						const calendarData = obj.data;
						if (!calendarData) continue;

						// Extract all VEVENT blocks
						const veventBlocks = calendarData.split('BEGIN:VEVENT').slice(1);

						for (const veventBlock of veventBlocks) {
							if (!veventBlock.includes('END:VEVENT')) continue;

							const eventData = 'BEGIN:VEVENT' + veventBlock.split('END:VEVENT')[0] + 'END:VEVENT';

							// Look for DTSTART in the specific event
							const eventDateMatches = [
								eventData.match(/DTSTART[^:]*:(\d{8}T\d{6}Z?)/),
								eventData.match(/DTSTART[^:]*:(\d{8})/),
								eventData.match(/DTSTART[^:]*:(\d{4}-\d{2}-\d{2})/),
							];

							for (const match of eventDateMatches) {
								if (!match) continue;

								const dateStr = match[1];
								const parsedDate = parseICalDate(dateStr, eventData);

								if (!parsedDate) continue;

								const eventDate = parsedDate.date;

								// Check direct date match
								if (eventDate.toDateString() === targetDate.toDateString()) {
									eventsForDate.push({
										url: obj.url,
										etag: obj.etag,
										calendarData: eventData
									});
									break;
								}

								// Check recurrence rules (RRULE)
								const rruleMatch = eventData.match(/RRULE:([^\r\n]+)/);
								if (rruleMatch && isRecurringEventOnDate(eventDate, targetDate, rruleMatch[1], eventData)) {
									const dtEndMatch = eventData.match(/DTEND[^:]*:(.+)/);
									const dtEndStr = dtEndMatch ? dtEndMatch[1].trim() : '';
									const parsedEndDate = dtEndStr ? parseICalDate(dtEndStr, eventData) : null;

									const { actualStartDate, actualEndDate } = calculateRecurringEventDates(
										eventDate,
										parsedEndDate?.date || null,
										targetDate
									);

									let modifiedEventData = eventData;

									const originalDtStart = eventData.match(/DTSTART[^:]*:([^\r\n]+)/);
									if (originalDtStart) {
										const isUtcStart = parsedDate.isUtc;
										const actualStartStr = formatDateToICal(actualStartDate, isUtcStart);
										const startLine = originalDtStart[0];
										const newStartLine = startLine.replace(originalDtStart[1], actualStartStr);
										modifiedEventData = modifiedEventData.replace(startLine, newStartLine);
									}

									if (actualEndDate && dtEndMatch) {
										const isUtcEnd = parsedEndDate?.isUtc || false;
										const actualEndStr = formatDateToICal(actualEndDate, isUtcEnd);
										const endLine = dtEndMatch[0];
										const newEndLine = endLine.replace(dtEndMatch[1], actualEndStr);
										modifiedEventData = modifiedEventData.replace(endLine, newEndLine);
									}

									eventsForDate.push({
										url: obj.url,
										etag: obj.etag,
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
						if (!eventData) continue;

						const summaryMatch = eventData.match(/SUMMARY:(.+)/);
						const descriptionMatch = eventData.match(/DESCRIPTION:(.+)/);
						const dtStartMatch = eventData.match(/DTSTART[^:]*:(.+)/);
						const dtEndMatch = eventData.match(/DTEND[^:]*:(.+)/);
						const uidMatch = eventData.match(/UID:(.+)/);
						const locationMatch = eventData.match(/LOCATION:(.+)/);
						const webUrlMatch = eventData.match(/URL:(.+)/);

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
							pairedItem: { item: i },
						});
					}

					// If no events found, throw error with debug info
					if (eventsForDate.length === 0) {
						const sampleEvents: SampleEvent[] = [];

						for (let j = 0; j < Math.min(2, calendarObjects.length); j++) {
							const obj = calendarObjects[j];
							const calendarData = obj.data;
							if (!calendarData) {
								sampleEvents.push({ error: 'No calendarData' });
								continue;
							}

							const veventBlocks = calendarData.split('BEGIN:VEVENT').slice(1);

							sampleEvents.push({
								objectIndex: j,
								totalVEventBlocks: veventBlocks.length,
								firstVEventPreview: veventBlocks.length > 0 ?
									('BEGIN:VEVENT' + veventBlocks[0].split('END:VEVENT')[0]).substring(0, 300) + '...' : 'No VEVENT found',
								calendarDataStart: calendarData.substring(0, 200) + '...'
							});

							for (let k = 0; k < Math.min(2, veventBlocks.length); k++) {
								const veventBlock = veventBlocks[k];
								if (!veventBlock.includes('END:VEVENT')) continue;

								const eventData = 'BEGIN:VEVENT' + veventBlock.split('END:VEVENT')[0] + 'END:VEVENT';
								const dtStartMatch = eventData.match(/DTSTART[^:]*:([^\r\n]+)/);
								const summaryMatch = eventData.match(/SUMMARY:([^\r\n]+)/);

								sampleEvents.push({
									objectIndex: j,
									eventIndex: k,
									dtStart: dtStartMatch ? dtStartMatch[1] : 'No DTSTART found',
									summary: summaryMatch ? summaryMatch[1] : 'No SUMMARY found',
									eventDataPreview: eventData.substring(0, 200) + '...'
								});
							}
						}

						throw new NodeOperationError(
							this.getNode(),
							`No events found for ${targetDate.toDateString()}. Calendar: ${calendarUrl}, Objects found: ${calendarObjects.length}`,
							{
								itemIndex: i,
								description: 'No events found for the specified date',
							}
						);
					}
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: (error as Error).message,
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
