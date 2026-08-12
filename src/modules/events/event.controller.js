const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const eventService = require('./event.service');

/**
 * `ownerId` branches this exactly like GET /businesses (see
 * business.controller.js's getBusinesses) — "my events," across every
 * business the caller owns, requires being logged in as that same owner.
 * No pagination on this branch, same reasoning as getMyBusinesses: an
 * owner's own list is bounded by how many events they've personally
 * created, never the whole platform's worth.
 */
const getEvents = asyncHandler(async (req, res) => {
  const { category, businessId, from, to, page, limit, ownerId } = req.query;

  if (ownerId) {
    if (!req.user) {
      throw ApiError.unauthorized('Login required to view your events');
    }
    if (ownerId !== req.user.id) {
      throw ApiError.forbidden('You can only view your own events');
    }
    const events = await eventService.getMyEvents(req.user.id);
    return res.json({ data: events });
  }

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

const updateEvent = asyncHandler(async (req, res) => {
  const event = await eventService.updateEvent(req.params.id, req.user.id, req.body);
  res.json(event);
});

const addInterest = asyncHandler(async (req, res) => {
  await eventService.addInterest(req.user.id, req.params.id);
  res.status(204).send();
});

const removeInterest = asyncHandler(async (req, res) => {
  await eventService.removeInterest(req.user.id, req.params.id);
  res.status(204).send();
});

module.exports = { getEvents, getEventById, createEvent, updateEvent, addInterest, removeInterest };
