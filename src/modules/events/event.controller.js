const asyncHandler = require('../../utils/asyncHandler');
const eventService = require('./event.service');

const getEvents = asyncHandler(async (req, res) => {
  const { category, businessId, from, to, page, limit } = req.query;
  const { events, pagination } = await eventService.getEvents({
    category, businessId, from, to, page, limit,
  });
  res.json({ data: events, pagination });
});

const getEventById = asyncHandler(async (req, res) => {
  const event = await eventService.getEventById(req.params.id);
  res.json(event);
});

const createEvent = asyncHandler(async (req, res) => {
  const event = await eventService.createEvent(req.user.id, req.body);
  res.status(201).json(event);
});

module.exports = { getEvents, getEventById, createEvent };
