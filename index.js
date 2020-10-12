const { Requester, Validator } = require('@chainlink/external-adapter')
const axios = require('axios')

const Firestore = require('@google-cloud/firestore');
const PROJECTID = process.env.FIRESTORE_PROJECT_ID;
const COLLECTION_NAME = process.env.FIRESTORE_COLLECTION_NAME;
const firestore = new Firestore({
	projectId: PROJECTID,
	timestampsInSnapshots: true,
});

//TODO: whitelist to reject any requests if not from specific chainlink node IPs 

// structure for input json is as follows. In this example, jobSpec is 22, & actions can be any of the ones listed below
// { 
// 	"id": 22,
// 	"data": { 
// 	"apiToken": "abcdefghi",
// 	"vehicleId": "23423423423423423423",
// 	"action": "authenticate" , "vehicles", "wake_up", "vehicle_data", "unlock", "lock", "honk_horn",
// 	}
// }

const createRequest = async (input, callback) => {

	// Get input values
	let jobRunID = input.id
	let vehicleId = input.data.vehicleId
	let address; // The smart contract address
	let storedToken;
	let authenticationToken;

	const base_url = process.env.BASE_URL

	const WAKE_UP_URL = base_url + `api/1/vehicles/${vehicleId}/wake_up`
	const VEHICLE_DATA_URL = base_url + `api/1/vehicles/${vehicleId}/vehicle_data`
	const UNLOCK_VEHICLE_URL = base_url + `api/1/vehicles/${vehicleId}/command/door_unlock`
	const LOCK_VEHICLE_URL = base_url + `api/1/vehicles/${vehicleId}/command/door_lock`
	const HONK_HORN_URL = base_url + `api/1/vehicles/${vehicleId}/command/honk_horn`

	// Depending on the scenario get the authentication token either from the authentication request or from Google Cloud Firestore
	if (input.data.action == 'authenticate') {  //get value from request
		authenticationToken = `Bearer ${input.data.apiToken}`
		address = input.data.address
	} else {   // get value from Cloud Firestore		
		const apiTokenRef = firestore.collection(COLLECTION_NAME).doc(vehicleId);
		const doc = await apiTokenRef.get();
		if (!doc.exists) {
			console.log('No such document in firestore!');
		} else {
			console.log('Document data:', doc.data());
			storedToken = doc.data().tokenToStore;
		}
		authenticationToken = `Bearer ${storedToken}`
	}

	const headers = {
		'Content-Type': 'application/json',
		'Authorization': authenticationToken
	}

	const LAT_LONG_MULTIPLICATION_FACTOR = 1000000

	// Retrieve vehicle data. This includes odometer, charge level, longitude & latitude.
	// Fields are available in the following json locations:
	// odometer: response.vehicle_state.odometer. This is in miles and in decimals so convert/round to whole number
	// chargeLevel: response.charge_state.battery_level 
	// longitude: response.drive_state.longitude
	// latitude: response.drive_state.latitude
	const getVehicleData = () => axios.get(VEHICLE_DATA_URL, { headers: headers })
		.then(function (response) {
			const odometer = Math.round(response.data.response.vehicle_state.odometer)
			const chargeLevel = response.data.response.charge_state.battery_level
			const longitude = response.data.response.drive_state.longitude * LAT_LONG_MULTIPLICATION_FACTOR
			const latitude = response.data.response.drive_state.latitude * LAT_LONG_MULTIPLICATION_FACTOR

			return `{${odometer},${chargeLevel},${longitude},${latitude}}`
		});

	// First thing we need to always do is wake the vehicle up. If successful, then its ready to receive a request
	try {
		await axios.post(WAKE_UP_URL, null, { headers: headers })
			.then(async function (response) {
				// Only do callback if we're doing an authenticate, otherwise there'll be other requests to come
				if (input.data.action == 'authenticate' && response.status == 200) {

					// Authentication was successful. Store the key to be used/retrieved for future requests, then do callback
					try {
						const tokenToStore = input.data.apiToken;
						await firestore.collection(COLLECTION_NAME).doc(vehicleId).set({ tokenToStore });
					} catch (error) {
						console.log("Error storing token in Firestore database")
						throw error
					}

					// Now that the API token has been stored in the data store, we can do the callback, passing the address back to be used to update vehicle status
					callback(response.status,
						{
							jobRunID,
							data: address,
							result: address,
							statusCode: response.status
						});
				}
			});
	} catch (error) {
		callback(response.status, Requester.errored(jobRunID, error))
	}

	// Now depending on action, do different requests
	switch (input.data.action) {
		case 'authenticate':
			// Vehicle is being created. If the wakeup was successful then we don't need to do anything here, just return the vehicle address
			break;

		case 'vehicle_data':
			try {
				await getVehicleData()
					.then((data) => {
						callback(response.status,
							{
								jobRunID,
								data,
								result: null,
								statusCode: response.status
							});
					});
			} catch (error) {
				callback(500, Requester.errored(jobRunID, error))
			}

			break;

		// For both unlock & lock, for this use case we also need to obtain vehicle data values, as the on-chain contract will need them to log specific data 
		case 'unlock':
			try {

				// First get vehicle data
				const vehicleData = await getVehicleData();

				// Now that we have the data, we can unlock the vehicle
				await axios.post(UNLOCK_VEHICLE_URL, null, { headers: headers })
					.then(function (response) {
						callback(response.status,
							{
								jobRunID,
								data: vehicleData,
								result: null,
								statusCode: response.status
							});
					});
			} catch (error) {
				callback(500, Requester.errored(jobRunID, error))
			}

			break;

		case 'lock':
			try {

				// First get vehicle data
				const vehicleData = await getVehicleData();

				// Now that we have the data, we can lock the vehicle
				await axios.post(LOCK_VEHICLE_URL, null, { headers: headers })
					.then(function (response) {
						callback(response.status,
							{
								jobRunID,
								data: vehicleData,
								result: null,
								statusCode: response.status
							});
					});
			} catch (error) {
				callback(500, Requester.errored(jobRunID, error))
			}

			break;

		case 'honk_horn':
			try {
				await axios.post(HONK_HORN_URL, null, { headers: headers })
					.then(function (response) {
						callback(response.status, Requester.success(jobRunID, response))
					});
			} catch (error) {
				callback(500, Requester.errored(jobRunID, error))
			}
			break;

		case 'vehicles':
			// TODO: Not implemented
			console.log('Action not yet implemented');
			break;

		default:
			console.log('invalid parameter');
	}
}

// This is a wrapper to allow the function to work with
// GCP Functions
exports.gcpservice = (req, res) => {
	createRequest(req.body, (statusCode, data) => {
		res.status(statusCode).send(data)
	})
}

// This is a wrapper to allow the function to work with
// AWS Lambda
exports.handler = (event, context, callback) => {
	createRequest(event, (statusCode, data) => {
		callback(null, data)
	})
}

// This is a wrapper to allow the function to work with
// newer AWS Lambda implementations
exports.handlerv2 = (event, context, callback) => {
	createRequest(JSON.parse(event.body), (statusCode, data) => {
		callback(null, {
			statusCode: statusCode,
			body: JSON.stringify(data),
			isBase64Encoded: false
		})
	})
}

// This allows the function to be exported for testing
// or for running in express
module.exports.createRequest = createRequest
