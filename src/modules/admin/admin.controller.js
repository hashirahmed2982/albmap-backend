const asyncHandler = require('../../utils/asyncHandler');
const adminService = require('./admin.service');

const getDashboardStats = asyncHandler(async (req, res) => {
  const stats = await adminService.getDashboardStats();
  res.json(stats);
});

const getPendingBusinesses = asyncHandler(async (req, res) => {
  const businesses = await adminService.getPendingBusinesses();
  res.json({ data: businesses });
});

const getAllBusinesses = asyncHandler(async (req, res) => {
  const { status, search } = req.query;
  const businesses = await adminService.getAllBusinesses({ status, search });
  res.json({ data: businesses });
});

const reviewBusiness = asyncHandler(async (req, res) => {
  const { decision, reason } = req.body;
  const business = await adminService.reviewBusiness(req.params.id, req.user.id, decision, reason);
  res.json(business);
});

const setBusinessActive = asyncHandler(async (req, res) => {
  const business = await adminService.deactivateBusiness(req.params.id, req.body.isActive);
  res.json(business);
});

const getAllUsers = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const users = await adminService.getAllUsers({ search });
  res.json({ data: users });
});

const setUserActive = asyncHandler(async (req, res) => {
  await adminService.setUserActive(req.params.id, req.body.isActive);
  res.status(204).send();
});

const getAllEvents = asyncHandler(async (req, res) => {
  const events = await adminService.getAllEvents();
  res.json({ data: events });
});

const setEventActive = asyncHandler(async (req, res) => {
  await adminService.setEventActive(req.params.id, req.body.isActive);
  res.status(204).send();
});

const getAllAdmins = asyncHandler(async (req, res) => {
  const admins = await adminService.getAllAdmins();
  res.json({ data: admins });
});

const createAdmin = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body;
  const admin = await adminService.createAdmin({ email, password, name });
  res.status(201).json(admin);
});

const deleteAdmin = asyncHandler(async (req, res) => {
  await adminService.deleteAdmin(req.params.id, req.user.id);
  res.status(204).send();
});

const getAllCategories = asyncHandler(async (req, res) => {
  const categories = await adminService.getAllCategories();
  res.json({ data: categories });
});

const createCategory = asyncHandler(async (req, res) => {
  const { name, iconName, sortOrder } = req.body;
  const category = await adminService.createCategory({ name, iconName, sortOrder });
  res.status(201).json(category);
});

const updateCategory = asyncHandler(async (req, res) => {
  const { name, iconName, sortOrder } = req.body;
  const category = await adminService.updateCategory(req.params.id, { name, iconName, sortOrder });
  res.json(category);
});

const deleteCategory = asyncHandler(async (req, res) => {
  await adminService.deleteCategory(req.params.id);
  res.status(204).send();
});

const getPendingBroadcasts = asyncHandler(async (req, res) => {
  const notifications = await adminService.getPendingBroadcasts();
  res.json({ data: notifications });
});

const getAllBroadcasts = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const notifications = await adminService.getAllBroadcasts({ status });
  res.json({ data: notifications });
});

const reviewBroadcast = asyncHandler(async (req, res) => {
  const { decision, reason } = req.body;
  const result = await adminService.reviewBroadcast(req.params.id, req.user.id, decision, reason);
  res.json(result);
});

const updateContent = asyncHandler(async (req, res) => {
  const content = await adminService.updateContent(req.params.key, req.body, req.user.id);
  res.json(content);
});

module.exports = {
  getDashboardStats,
  getPendingBusinesses,
  getAllBusinesses,
  reviewBusiness,
  setBusinessActive,
  getAllUsers,
  setUserActive,
  getAllEvents,
  setEventActive,
  getAllAdmins,
  createAdmin,
  deleteAdmin,
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getPendingBroadcasts,
  getAllBroadcasts,
  reviewBroadcast,
  updateContent,
};
