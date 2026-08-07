const asyncHandler = require('../../utils/asyncHandler');
const eventService = require('./event.service');

const getEvents = asyncHandler(async (req, res) => {
  const { category, businessId, from, to, page, limit } = req.query;
  const { events, pagination } = await eventService.getEvents({
    category, businessId, from, to, page, limit, userId: req.user?.id,
  });
  res.json({ data: events, pagination });
});

const getEventById = asyncHandler(async (req, res) => {
  const event = await eventService.getEventById(req.params.id, req.user?.id);
  res.json(event);
});

const createEvent = asyncHandler(async (req, res) => {
  const event = await eventService.createEvent(req.user.id, req.body);
  res.status(201).json(event);
});

const addInterest = asyncHandler(async (req, res) => {
  await eventService.addInterest(req.user.id, req.params.id);
  res.status(204).send();
});

const removeInterest = asyncHandler(async (req, res) => {
  await eventService.removeInterest(req.user.id, req.params.id);
  res.status(204).send();
});

module.exports = { getEvents, getEventById, createEvent, addInterest, removeInterest };
