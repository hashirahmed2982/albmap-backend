const asyncHandler = require('../../utils/asyncHandler');
const authService = require('./auth.service');

const signup = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body;
  await authService.requestSignupOtp({ email, password, name });
  // Deliberately no user/token payload — no account exists yet. The
  // client's next step is to show an "enter the code we emailed you"
  // screen and call POST /auth/signup/verify.
  res.json({ message: 'Verification code sent to your email.' });
});

const verifySignup = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  const result = await authService.verifySignupOtp({ email, otp });
  res.status(201).json(result);
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await authService.login({ email, password });
  res.json(result);
});

const loginWithGoogle = asyncHandler(async (req, res) => {
  const result = await authService.loginWithGoogle(req.body);
  res.json(result);
});

const loginWithFacebook = asyncHandler(async (req, res) => {
  const result = await authService.loginWithFacebook(req.body);
  res.json(result);
});

const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const result = await authService.refresh({ refreshToken });
  res.json(result);
});

const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  await authService.logout({ refreshToken });
  res.status(204).send();
});

const me = asyncHandler(async (req, res) => {
  const user = await authService.getCurrentUser(req.user.id);
  res.json(user);
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  await authService.forgotPassword({ email });
  // Generic response regardless of outcome — see service-layer comment.
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  await authService.resetPassword({ token, newPassword });
  res.json({ message: 'Password reset successfully.' });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user.id, { currentPassword, newPassword });
  res.json({ message: 'Password changed successfully.' });
});

const deleteAccount = asyncHandler(async (req, res) => {
  const { password } = req.body;
  await authService.deleteAccount(req.user.id, { password });
  res.status(204).send();
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, phone, profileImageUrl } = req.body;
  const user = await authService.updateProfile(req.user.id, { name, phone, profileImageUrl });
  res.json(user);
});

module.exports = {
  signup,
  verifySignup,
  login,
  loginWithGoogle,
  loginWithFacebook,
  refresh,
  logout,
  me,
  forgotPassword,
  resetPassword,
  changePassword,
  deleteAccount,
  updateProfile,
};
